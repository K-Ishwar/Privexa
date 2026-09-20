/**
 * UI-Specific YOLO26 Vision Worker
 * =====================================
 * Runs real ONNX inference with the locally-trained best_int8.onnx model.
 * Executes entirely in the browser — no pixels ever leave the device.
 *
 * YOLO26 Output Format (NMS-Free):
 *   output0 shape: [1, 12, 8400]
 *   The 12 values per anchor: [cx, cy, w, h, class0_conf, ..., class7_conf]
 *
 * Class Map (8 classes from data.yaml):
 *   0: button  1: field  2: heading  3: iframe
 *   4: image   5: label  6: link     7: text
 */

// ONNX Runtime Web is shipped as part of @huggingface/transformers
// We only need the raw `ort` namespace for custom ONNX sessions.
import * as ort from 'onnxruntime-web';

// ── Constants ────────────────────────────────────────────────────────────────
const MODEL_INPUT_SIZE = 640;          // YOLO26 expects 640×640 RGB
const CONF_THRESHOLD   = 0.30;         // Minimum class confidence to keep
const NUM_CLASSES      = 8;
const NUM_ANCHORS      = 8400;         // Fixed in YOLOv8/v26 head

const CLASS_NAMES: string[] = [
  'button', 'field', 'heading', 'iframe',
  'image',  'label', 'link',    'text'
];

// Map YOLO26 class names → the extension's existing schema Role types
const CLASS_TO_ROLE: Record<string, string> = {
  button:  'BUTTON',
  field:   'INPUT',
  heading: 'TEXT',
  iframe:  'IMAGE',
  image:   'IMAGE',
  label:   'TEXT',
  link:    'LINK',
  text:    'TEXT',
};

// ── State ────────────────────────────────────────────────────────────────────
let session: ort.InferenceSession | null = null;
let offscreenCanvas: OffscreenCanvas | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Load and cache the ONNX session. Called once on INIT. */
async function loadModel(): Promise<void> {
  if (session) return;

  // In a Chrome extension context, assets are resolved via chrome.runtime.getURL.
  // This avoids the import.meta.url issue with IIFE/ESM bundles.
  const modelUrl = (globalThis as any).chrome?.runtime?.getURL('assets/best_int8.onnx')
    ?? 'assets/best_int8.onnx';

  // Try WebGPU first (GPU-accelerated, ~5-10x faster than WASM on supported hardware).
  // Automatically falls back to WASM (CPU) if WebGPU is unavailable or unsupported.
  try {
    session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['webgpu'],
      graphOptimizationLevel: 'all',
    });
    console.info('[Privexa/vit] ONNX session started on WebGPU ✅');
  } catch {
    console.info('[Privexa/vit] WebGPU unavailable — falling back to WASM.');
    session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
    });
    console.info('[Privexa/vit] ONNX session started on WASM ✅');
  }
}

/**
 * Pre-process: fetch the image, resize it to 640×640, and build a planar
 * Float32 RGB tensor normalised to [0, 1].
 */
async function preprocess(imageUrl: string): Promise<{
  tensor: ort.Tensor;
  origWidth: number;
  origHeight: number;
}> {
  const response = await fetch(imageUrl);
  const blob     = await response.blob();
  const bitmap   = await createImageBitmap(blob);

  const origWidth  = bitmap.width;
  const origHeight = bitmap.height;

  if (!offscreenCanvas) {
    offscreenCanvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  }
  const ctx = offscreenCanvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);

  // Build planar [R, G, B] tensor: [1, 3, 640, 640]
  const numPixels = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const floatData = new Float32Array(3 * numPixels);
  for (let i = 0; i < numPixels; i++) {
    floatData[i]                  = data[i * 4]     / 255; // R
    floatData[i + numPixels]      = data[i * 4 + 1] / 255; // G
    floatData[i + numPixels * 2]  = data[i * 4 + 2] / 255; // B
  }

  const tensor = new ort.Tensor('float32', floatData, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
  return { tensor, origWidth, origHeight };
}

/**
 * Post-process the raw YOLO26 NMS-Free output tensor.
 * Output shape: [1, NUM_CLASSES+4, NUM_ANCHORS]
 */
function postprocess(
  rawOutput: ort.Tensor,
  origWidth: number,
  origHeight: number,
  threshold: number
): DetectionResult[] {
  // Shape: [1, 12, 8400] — access as [channel][anchor]
  const data = rawOutput.data as Float32Array;
  const scaleX = origWidth  / MODEL_INPUT_SIZE;
  const scaleY = origHeight / MODEL_INPUT_SIZE;

  const results: DetectionResult[] = [];

  for (let a = 0; a < NUM_ANCHORS; a++) {
    // Row-major: value at [channel, anchor] = data[channel * NUM_ANCHORS + anchor]
    const cx = data[0 * NUM_ANCHORS + a];
    const cy = data[1 * NUM_ANCHORS + a];
    const bw = data[2 * NUM_ANCHORS + a];
    const bh = data[3 * NUM_ANCHORS + a];

    // Find the best class
    let bestClass = -1;
    let bestConf  = -Infinity;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const conf = data[(4 + c) * NUM_ANCHORS + a];
      if (conf > bestConf) { bestConf = conf; bestClass = c; }
    }

    if (bestConf < threshold || bestClass < 0) continue;

    // Convert YOLO centre+wh → top-left x,y in original image pixels
    const x = Math.max(0, Math.round((cx - bw / 2) * scaleX));
    const y = Math.max(0, Math.round((cy - bh / 2) * scaleY));
    const w = Math.min(origWidth  - x, Math.round(bw * scaleX));
    const h = Math.min(origHeight - y, Math.round(bh * scaleY));

    if (w <= 0 || h <= 0) continue;

    const label = CLASS_NAMES[bestClass];
    results.push({
      label,
      role:       CLASS_TO_ROLE[label] ?? 'TEXT',
      confidence: bestConf,
      box:        { x, y, width: w, height: h },
    });
  }

  // Sort by confidence descending to keep the most certain detections first
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

// ── Types ────────────────────────────────────────────────────────────────────
interface DetectionResult {
  label:      string;
  role:       string;
  confidence: number;
  box:        { x: number; y: number; width: number; height: number };
}

// ── Message Handler ──────────────────────────────────────────────────────────
self.onmessage = async (event: MessageEvent) => {
  const { type, imageUrl, threshold = CONF_THRESHOLD } = event.data;

  if (type === 'INIT') {
    try {
      await loadModel();
      self.postMessage({ type: 'INIT_COMPLETE' });
    } catch (e: any) {
      self.postMessage({ type: 'ERROR', error: `YOLO26 model failed to load: ${e.message}` });
    }
    return;
  }

  if (type === 'DETECT') {
    if (!session) {
      self.postMessage({ type: 'ERROR', error: 'Worker not initialised — send INIT first.' });
      return;
    }
    if (!imageUrl || typeof imageUrl !== 'string') {
      self.postMessage({ type: 'ERROR', error: 'imageUrl is required.' });
      return;
    }

    try {
      const startMs = performance.now();

      const { tensor, origWidth, origHeight } = await preprocess(imageUrl);

      // Run inference — YOLO26 expects input named "images"
      const feeds  = { images: tensor };
      const output = await session.run(feeds);

      // Dispose the input tensor immediately to free WASM heap memory
      tensor.dispose();

      // The primary detection output is typically named "output0"
      const rawOutput = output['output0'] ?? Object.values(output)[0];
      const results   = postprocess(rawOutput as ort.Tensor, origWidth, origHeight, threshold);

      const durationMs = Math.round(performance.now() - startMs);

      self.postMessage({ type: 'DETECT_COMPLETE', results, durationMs });
    } catch (e: any) {
      self.postMessage({ type: 'ERROR', error: e.message });
    }
    return;
  }
};
