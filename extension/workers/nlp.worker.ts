import { pipeline, env } from '@huggingface/transformers';

// Since we are running in an extension worker, use IndexedDB cache or local models
env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_ID = 'Xenova/bert-base-multilingual-cased-ner-hrl';
let classifierPromise: Promise<any> | null = null;

async function loadNlpModel() {
  if (!classifierPromise) {
    classifierPromise = pipeline('token-classification', MODEL_ID, {
      progress_callback: (info: any) => {
        postMessage({ type: 'PROGRESS', payload: info });
      },
    });
  }
  return classifierPromise;
}

self.addEventListener('message', async (event) => {
  const { type, text, id } = event.data;
  
  if (type === 'CLASSIFY_TEXT') {
    try {
      const classifier = await loadNlpModel();
      const results = await classifier(text);
      postMessage({ type: 'CLASSIFY_RESULT', id, results });
    } catch (error) {
      postMessage({ type: 'CLASSIFY_ERROR', id, error: String(error) });
    }
  } else if (type === 'PRELOAD') {
    await loadNlpModel();
    postMessage({ type: 'PRELOAD_DONE' });
  }
});
