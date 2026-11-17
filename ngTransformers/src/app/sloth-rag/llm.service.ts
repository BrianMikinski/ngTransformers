import { Injectable, computed, signal } from '@angular/core';
import { ChatMessage } from './answer-utils';

export interface LlmModel {
  id: string;
  label: string;
  note: string;
  /** Download size of the WebGPU (q4f16) weights. */
  mb: number;
}

/**
 * Models tried and rejected (see docs/features/FT001-sloth-rag-ux.md):
 * - Qwen2.5 0.5B/1.5B: activations overflow fp16, so q4f16 on WebGPU writes garbage; q4 (fp32) is correct
 *   but too slow on integrated GPUs.
 * - Qwen3 1.7B (q4f16, 1.4GB): onnxruntime-web aborts while creating the session (out of WASM memory).
 * The picker in the UI appears once there's more than one entry here.
 */
export const LLM_MODELS: LlmModel[] = [
  { id: 'onnx-community/Qwen3-0.6B-ONNX', label: 'Qwen3 0.6B', note: 'small and fast', mb: 570 },
];

/** off: not enabled yet (nothing downloaded) · idle: enabled, not loaded in this tab yet. */
export type LlmStatus = 'off' | 'idle' | 'loading' | 'compiling' | 'ready' | 'error';

export interface GenerateResult {
  text: string;
  interrupted: boolean;
  promptTokens?: number;
  tokens?: number;
  ms?: number;
  tokensPerSecond?: number;
  device?: string;
  dtype?: string;
}

const ENABLED_KEY = 'sloth-rag.answers';
const MODEL_KEY = 'sloth-rag.llmModel';
/** Debug override for the worker's device/weights, e.g. "webgpu:q4" or "wasm:int8". */
const BACKEND_KEY = 'sloth-rag.llmBackend';

/**
 * The answer/SQL model in a Web Worker (see llm.worker.ts). Nothing downloads until the user enables
 * answers; after that the weights are browser-cached and load from disk on later visits.
 */
@Injectable({ providedIn: 'root' })
export class LlmService {
  readonly hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
  readonly enabled = signal(read(ENABLED_KEY) === 'true');
  readonly modelId = signal(LLM_MODELS.some(m => m.id === read(MODEL_KEY)) ? read(MODEL_KEY)! : LLM_MODELS[0].id);
  readonly model = computed(() => LLM_MODELS.find(m => m.id === this.modelId()) ?? LLM_MODELS[0]);
  readonly #status = signal<Exclude<LlmStatus, 'off'>>('idle');
  readonly status = computed<LlmStatus>(() => (this.enabled() ? this.#status() : 'off'));
  /** 0-100 while downloading, undefined otherwise. */
  readonly downloadProgress = signal<number | undefined>(undefined);
  readonly downloadMb = signal<number | undefined>(undefined);
  /** 'webgpu' or 'wasm' once loading started. */
  readonly device = signal<string | undefined>(undefined);
  readonly busy = signal(false);
  /** Tokens generated so far by the running request (updated every few tokens). */
  readonly tokens = signal(0);

  #worker?: Worker;
  #pending = new Map<number, {
    resolve: (r: GenerateResult) => void;
    reject: (e: Error) => void;
    onToken?: (t: string) => void;
  }>();
  #nextId = 0;

  enable() {
    this.enabled.set(true);
    write(ENABLED_KEY, 'true');
  }

  disable() {
    this.stop();
    this.enabled.set(false);
    write(ENABLED_KEY, 'false');
    this.#reset();
  }

  /** Switching models restarts the worker; the new model downloads on the next request. */
  setModel(id: string) {
    if (id === this.modelId()) return;
    this.modelId.set(id);
    write(MODEL_KEY, id);
    this.#reset();
  }

  /** Runs a chat completion. Earlier requests still waiting or running are interrupted first. */
  /** `prefix` starts the model's reply (it continues from there); it's included in the result text. */
  generate(
    messages: ChatMessage[],
    opts: { maxNewTokens?: number; prefix?: string; onToken?: (t: string) => void } = {},
  ): Promise<GenerateResult> {
    this.enable();
    this.stop();
    const id = this.#nextId++;
    return new Promise<GenerateResult>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, onToken: opts.onToken });
      this.busy.set(true);
      this.tokens.set(0);
      this.#getWorker().postMessage({
        type: 'generate', id, model: this.modelId(), backend: read(BACKEND_KEY) || undefined, messages, maxNewTokens: opts.maxNewTokens ?? 320,
        prefix: opts.prefix,
      });
    });
  }

  /** Interrupt whatever is running or queued (it resolves with what was generated so far). */
  stop() {
    for (const id of this.#pending.keys()) this.#worker?.postMessage({ type: 'interrupt', id });
  }

  #getWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL('./llm.worker', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.event === 'progress') {
        this.downloadProgress.set(data.progress);
        if (data.mb) this.downloadMb.set(data.mb);
        return;
      }
      if (data.event === 'status') {
        this.#status.set(data.status);
        this.device.set(data.device);
        return;
      }
      const p = this.#pending.get(data.id);
      if (data.token !== undefined) {
        p?.onToken?.(data.token);
        return;
      }
      if (data.result === undefined && data.error === undefined) {
        this.tokens.set(data.tokens ?? 0);
        return;
      }
      this.#pending.delete(data.id);
      this.busy.set(this.#pending.size > 0);
      if (data.error) {
        // onnxruntime's WASM module is unusable after an abort (usually out of memory): start a fresh worker next time.
        const aborted = /\bAborted\(/.test(data.error);
        if (aborted) {
          worker.terminate();
          if (this.#worker === worker) this.#worker = undefined;
        }
        this.#status.set('error');
        const error = new Error(aborted ? 'the model ran out of memory. Close other tabs and try again.' : data.error);
        p?.reject(error);
        if (aborted) this.#failAll(error);
      } else {
        this.#status.set('ready');
        p?.resolve(data.result);
      }
    };
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      this.#failAll(new Error(`Answer model failed: ${e.message || 'could not load'}`));
      this.#status.set('error');
      worker.terminate();
      if (this.#worker === worker) this.#worker = undefined;
    };
    return this.#worker = worker;
  }

  #reset() {
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#failAll(new Error('Answer model was restarted'));
    this.#status.set('idle');
    this.downloadProgress.set(undefined);
    this.downloadMb.set(undefined);
  }

  #failAll(e: Error) {
    for (const p of this.#pending.values()) p.reject(e);
    this.#pending.clear();
    this.busy.set(false);
    this.downloadProgress.set(undefined);
  }
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked: session only */ }
}
