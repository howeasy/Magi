import { join } from 'node:path';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const services = new Map();
let injected = null;

// Tests supply inference, never a network-backed model.
export function setEmbedder(embedder) {
  injected = embedder;
  services.clear();
}

export function embeddingsFor(home) {
  if (services.has(home)) return services.get(home);
  const service = { model: injected ? 'injected' : EMBEDDING_MODEL, embed: injected, loading: null, pending: Promise.resolve(), started: false, error: null, queued: new Set() };
  service.start = () => {
    if (service.started || service.embed) return;
    service.started = true;
    if (process.env.MAGI_TEST_HOME) {
      service.error = 'model disabled in isolated tests';
      return;
    }
    // Initialization and any download happen after the request has returned.
    const timer = setTimeout(() => {
      service.loading = (async () => {
        const { pipeline } = await import('@huggingface/transformers');
        const options = { cache_dir: join(home, 'models'), dtype: 'q8' };
        let extractor;
        try { extractor = await pipeline('feature-extraction', EMBEDDING_MODEL, { ...options, local_files_only: true }); }
        catch { extractor = await pipeline('feature-extraction', EMBEDDING_MODEL, options); }
        service.embed = async (text) => {
          const result = await extractor(text, { pooling: 'mean', normalize: true });
          return Float32Array.from(result.data);
        };
      })().catch(() => { service.error = 'local model unavailable; check network access and MAGI_HOME/models, then restart Magi to retry'; });
    }, 0);
    timer.unref();
  };
  service.enqueue = (action) => {
    service.start();
    service.pending = service.pending.then(() => new Promise((resolve) => {
      const timer = setTimeout(resolve, 0);
      timer.unref();
    })).then(async () => {
      if (service.loading) await service.loading;
      if (service.embed) await action(service.embed, service.model);
    }).catch(() => { service.error = 'embedding failed; restart Magi to retry'; });
  };
  service.notice = () => service.error || (service.embed ? null : 'local model loading in background');
  services.set(home, service);
  return service;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export function vectorBlob(vector) {
  const floats = Float32Array.from(vector);
  if (!floats.length || !floats.every(Number.isFinite)) throw new Error('Invalid embedding vector');
  const bytes = Buffer.allocUnsafe(floats.length * 4);
  for (let i = 0; i < floats.length; i++) bytes.writeFloatLE(floats[i], i * 4);
  return bytes;
}

export function vectorFromBlob(bytes) {
  if (!bytes || bytes.byteLength % 4) return null;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < vector.length; i++) vector[i] = buffer.readFloatLE(i * 4);
  return vector;
}
