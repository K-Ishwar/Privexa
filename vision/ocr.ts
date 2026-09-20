import { createWorker } from 'tesseract.js';

let workerPromise: Promise<Tesseract.Worker> | null = null;

async function getOcrWorker(assetUrl: (path: string) => string) {
  if (!workerPromise) {
    workerPromise = (async () => {
      // Create a worker. In a real extension with strict CSP, you might need to point
      // workerPath and corePath to local assets bundled via your build step.
      // For this prototype, we'll let tesseract.js handle it (which fetches from CDN by default),
      // or point to local paths if you copy them to assets/.
      // Since the user requested "Model Hosting: yes", we'll configure it to use local
      // assets if they are available, else fallback to default CDN.
      
      const worker = await createWorker('eng', 1, {
        workerPath: assetUrl('assets/tesseract/worker.min.js'),
        corePath: assetUrl('assets/tesseract/tesseract-core.wasm.js'),
        langPath: assetUrl('assets/tesseract/lang-data'),
        logger: m => console.log('OCR Progress:', m),
      });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      console.error('Failed to initialize OCR worker', err);
      throw err;
    });
  }
  return workerPromise;
}

/**
 * Extracts text from an image data URL using Tesseract.js.
 * @param dataUrl The base64 data URL of the image chunk.
 * @param assetUrl A function to resolve extension asset paths.
 */
export async function extractTextFromImage(dataUrl: string, assetUrl: (path: string) => string): Promise<string> {
  try {
    // In a fully offline setup, we would ensure the worker and langPath are local.
    // We fall back to the default createWorker() if assetUrl paths don't exist in production.
    let worker;
    try {
      worker = await getOcrWorker(assetUrl);
    } catch {
      // Fallback to default (CDN) if local assets aren't set up yet
      worker = await createWorker('eng');
    }
    
    const { data: { text } } = await worker.recognize(dataUrl);
    return text;
  } catch (err) {
    console.error('OCR Extraction failed:', err);
    return '';
  }
}
