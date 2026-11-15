/// <reference lib="webworker" />
/**
 * A small instruct LLM (transformers.js) for written answers and natural language → SQL.
 * Runs on WebGPU when available (q4f16, or q4 without shader-f16), else on the CPU via WASM (slow).
 * One generation at a time; tokens stream back as they're produced; a request can be cancelled
 * before it starts or interrupted mid-generation.
 *
 * Messages in:  { type: 'generate', id, model, messages, maxNewTokens } | { type: 'interrupt', id }
 * Messages out: { event: 'progress' | 'status', ... } | { id, token } | { id, result } | { id, error }
 */
import {
  AutoModelForCausalLM, AutoTokenizer, InterruptableStoppingCriteria, TextStreamer,
} from '@huggingface/transformers';

interface Loaded { tokenizer: any; model: any; device: string; dtype: string; }

let loaded: Promise<Loaded> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let current: number | undefined;
const cancelled = new Set<number>();
const stopper = new InterruptableStoppingCriteria();

type Device = 'webgpu' | 'wasm';
type Dtype = 'q4f16' | 'q4' | 'int8';

/** `override` ("webgpu:q4", "wasm:int8") comes from localStorage 'sloth-rag.llmBackend', for debugging. */
async function pickDevice(override?: string): Promise<{ device: Device; dtype: Dtype }> {
  if (override) {
    const [device, dtype] = override.split(':') as [Device, Dtype];
    return { device, dtype };
  }
  const gpu = (navigator as any).gpu;
  const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
  if (!adapter) return { device: 'wasm', dtype: 'int8' };
  return { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'q4f16' : 'q4' };
}

function load(modelId: string, backend?: string): Promise<Loaded> {
  return loaded ??= (async () => {
    const { device, dtype } = await pickDevice(backend);
    postMessage({ event: 'status', status: 'loading', device, dtype });

    const files = new Map<string, { loaded: number; total: number }>();
    const progress_callback = (p: any) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let done = 0, total = 0;
      for (const f of files.values()) { done += f.loaded; total += f.total; }
      postMessage({ event: 'progress', progress: Math.round((done / total) * 100), mb: Math.round(total / 1e6) });
    };
    const tokenizer = await AutoTokenizer.from_pretrained(modelId, { progress_callback });
    const model = await AutoModelForCausalLM.from_pretrained(modelId, { dtype, device, progress_callback });
    postMessage({ event: 'progress', progress: undefined });

    // The first run compiles the GPU shaders, which takes a few seconds: do it now, not on the first answer.
    postMessage({ event: 'status', status: 'compiling', device, dtype });
    await model.generate({ ...tokenizer('Hi'), max_new_tokens: 1 });
    postMessage({ event: 'status', status: 'ready', device, dtype });
    return { tokenizer, model, device, dtype };
  })().catch(e => {
    loaded = undefined; // allow a retry
    postMessage({ event: 'progress', progress: undefined });
    throw e;
  });
}

async function generate(
  id: number, modelId: string, backend: string | undefined, messages: unknown[], maxNewTokens: number, prefix = '',
) {
  const { tokenizer, model, device, dtype } = await load(modelId, backend);
  if (cancelled.delete(id)) return { text: '', interrupted: true };

  // enable_thinking: Qwen3 would otherwise "think" for hundreds of tokens before answering.
  // prefix: the start of the reply is written for the model (e.g. "```sql\nSELECT"), which keeps small
  // models on format.
  const prompt: string = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, tokenize: false, enable_thinking: false });
  const inputs = tokenizer(prompt + prefix, { add_special_tokens: false });
  const promptTokens: number = inputs.input_ids.dims.at(-1);
  let text = prefix;
  if (prefix) postMessage({ id, token: prefix });
  let tokens = 0;
  let firstTokenAt: number | undefined;
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (t: string) => {
      text += t;
      postMessage({ id, token: t });
    },
    token_callback_function: () => {
      tokens++;
      firstTokenAt ??= performance.now();
      if (tokens % 8 === 0) postMessage({ id, tokens });
    },
  });

  stopper.reset();
  current = id;
  const start = performance.now();
  try {
    await model.generate({
      ...inputs,
      max_new_tokens: maxNewTokens,
      do_sample: false, // greedy: answers and SQL should be repeatable
      // Qwen's generation_config sets 1.1, which also penalizes every token in the prompt: the model then
      // avoids copying facts out of the sources ("25 days" became "10 days/weeks/year/year/...").
      repetition_penalty: 1.0,
      streamer,
      stopping_criteria: stopper,
    });
  } finally {
    current = undefined;
  }
  const end = performance.now();
  const genMs = firstTokenAt ? end - firstTokenAt : 0;
  return {
    text,
    interrupted: stopper.interrupted,
    promptTokens,
    tokens,
    ms: Math.round(end - start),
    tokensPerSecond: genMs > 0 && tokens > 1 ? Math.round(((tokens - 1) / genMs) * 1000 * 10) / 10 : undefined,
    device,
    dtype,
  };
}

addEventListener('message', ({ data }) => {
  if (data.type === 'interrupt') {
    cancelled.add(data.id);
    if (current === data.id) stopper.interrupt();
    return;
  }
  const { id, model, backend, messages, maxNewTokens, prefix } = data;
  const run = queue.then(() => generate(id, model, backend, messages, maxNewTokens, prefix));
  queue = run.catch(() => undefined);
  run.then(
    result => postMessage({ id, result }),
    e => postMessage({ id, error: e?.message ?? String(e) }),
  ).finally(() => cancelled.delete(id));
});
