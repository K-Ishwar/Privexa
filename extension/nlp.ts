// The nlp module now acts as a client for the nlp.worker.ts Web Worker.
let worker: Worker | null = null;
let messageIdCounter = 0;
const pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();

function getWorker(onProgress?: (info: any) => void) {
  if (!worker) {
    // In the extension, the worker is built alongside content/panel as nlp.worker.js
    const workerUrl = (globalThis as any).chrome ? (globalThis as any).chrome.runtime.getURL('nlp.worker.js') : 'nlp.worker.js';
    worker = new Worker(workerUrl);
    worker.onmessage = (event) => {
      const { type, payload, id, results, error } = event.data;
      if (type === 'PROGRESS' && onProgress) {
        onProgress(payload);
      } else if (type === 'CLASSIFY_RESULT' && pendingRequests.has(id)) {
        pendingRequests.get(id)!.resolve(results);
        pendingRequests.delete(id);
      } else if (type === 'CLASSIFY_ERROR' && pendingRequests.has(id)) {
        pendingRequests.get(id)!.reject(new Error(error));
        pendingRequests.delete(id);
      }
    };
  }
  return worker;
}

export async function loadNlpModel(onProgress?: (info: any) => void) {
  const w = getWorker(onProgress);
  w.postMessage({ type: 'PRELOAD' });
}

export async function detectPII(text: string, onProgress?: (info: any) => void): Promise<Array<{ word: string, entity_group: string }>> {
  if (!text || text.trim() === '') return [];
  const w = getWorker(onProgress);
  
  return new Promise((resolve, reject) => {
    const id = ++messageIdCounter;
    pendingRequests.set(id, { resolve, reject });
    w.postMessage({ type: 'CLASSIFY_TEXT', id, text });
  });
}

