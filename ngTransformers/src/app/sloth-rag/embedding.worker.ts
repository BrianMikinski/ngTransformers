/// <reference lib="webworker" />
/**
 * Sentence embeddings (transformers.js, all-MiniLM-L6-v2) off the main thread, so indexing a big
 * PDF or highlighting search results never freezes the page.
 * Requests run one at a time: they share one ONNX session.
 */
import { pipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

let extractor: Promise<any> | undefined;
let queue: Promise<unknown> = Promise.resolve();

function load() {
  return extractor ??= (() => {
    const files = new Map<string, { loaded: number; total: number }>();
    return pipeline('feature-extraction', MODEL, {
      progress_callback: (p: any) => {
        if (p.status !== 'progress' || !p.total) return;
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        postMessage({ event: 'progress', progress: Math.round((loaded / total) * 100) });
      },
    }).finally(() => postMessage({ event: 'progress', progress: undefined }));
  })().catch(e => {
    extractor = undefined; // allow a retry
    throw e;
  });
}

async function embed(texts: string[]): Promise<Float32Array[]> {
  const output = await (await load())(texts, { pooling: 'mean', normalize: true });
  const data = output.data as Float32Array;
  const dims = data.length / texts.length;
  return texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
}

addEventListener('message', ({ data: { id, texts } }) => {
  const run = queue.then(() => embed(texts));
  queue = run.catch(() => undefined);
  run.then(
    vectors => postMessage({ id, result: vectors }, vectors.map(v => v.buffer)),
    e => postMessage({ id, error: e?.message ?? String(e) }),
  );
});
