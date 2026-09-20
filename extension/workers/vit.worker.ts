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
const CONF_THRESHOLD   = 0.20;         // Minimum class confidence to keep
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

  // Inside a Chrome extension Web Worker, self.location.href is:
  //   chrome-extension://[id]/workers/vit.worker.js
  // We derive paths relative to the worker's actual URL so they resolve correctly.
  const workerBase = new URL('./', self.location.href).href;       // .../workers/
  const extensionBase = new URL('../', self.location.href).href;  // .../

  // Tell ONNX Runtime exactly where to find its WASM files (same dir as worker)
  ort.env.wasm.wasmPaths = workerBase;
  ort.env.wasm.numThreads = 1; // avoid SharedArrayBuffer requirement in extensions

  // The ONNX model lives in assets/ one level up from workers/
  const modelUrl = extensionBase + 'assets/best_int8.onnx';
  console.info('[Privexa/vit] Loading model from:', modelUrl);
  console.info('[Privexa/vit] WASM path:', workerBase);

  // Try WASM backend (most compatible in Chrome extension context)
  try {
    session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
    });
    console.info('[Privexa/vit] ONNX session started on WASM ✅');
  } catch (e1: any) {
    // Fallback: try with WebGPU if available
    console.info('[Privexa/vit] WASM failed, trying WebGPU:', e1.message);
    try {
      session = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      console.info('[Privexa/vit] ONNX session started on WebGPU ✅');
    } catch (e2: any) {
      throw new Error(`No backend available. WASM: ${e1.message} | WebGPU: ${e2.message}`);
    }
  }
}

/**
 * Pre-process: fetch the image, letterbox it to 640x640 (to maintain aspect ratio),
 * and build a planar Float32 RGB tensor normalised to [0, 1].
 */
async function preprocess(imageUrl: string): Promise<{
  tensor: ort.Tensor;
  origWidth: number;
  origHeight: number;
  scale: number;
  padX: number;
  padY: number;
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
  
  // Clear with neutral grey (standard YOLO padding)
  ctx.fillStyle = '#727272';
  ctx.fillRect(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);

  // Letterbox calculations
  const scale = Math.min(MODEL_INPUT_SIZE / origWidth, MODEL_INPUT_SIZE / origHeight);
  const newWidth = Math.round(origWidth * scale);
  const newHeight = Math.round(origHeight * scale);
  const padX = Math.round((MODEL_INPUT_SIZE - newWidth) / 2);
  const padY = Math.round((MODEL_INPUT_SIZE - newHeight) / 2);

  ctx.drawImage(bitmap, padX, padY, newWidth, newHeight);
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
 * Supports both output shapes:
 *   - [1, NUM_CLASSES+4, NUM_ANCHORS]  (channels-first, PyTorch export)
 *   - [1, NUM_ANCHORS, NUM_CLASSES+4]  (anchors-first, some ONNX exports)
 */
function postprocess(
  rawOutput: ort.Tensor,
  origWidth: number,
  origHeight: number,
  scale: number,
  padX: number,
  padY: number,
  threshold: number
): DetectionResult[] {
  const data = rawOutput.data as Float32Array;
  const dims = rawOutput.dims; // e.g. [1, 12, 8400] or [1, 8400, 12]

  // Auto-detect layout from output shape
  const d1 = dims[1] as number;
  const d2 = dims[2] as number;

  const isChannelsFirst = d1 < d2;
  const numAnchors = isChannelsFirst ? d2 : d1;
  const numChannels = isChannelsFirst ? d1 : d2; 

  console.info(`[Privexa/YOLO] output shape: [1, ${d1}, ${d2}]  layout=${isChannelsFirst ? 'channels-first' : 'anchors-first'}  anchors=${numAnchors}`);

  const results: DetectionResult[] = [];

  for (let a = 0; a < numAnchors; a++) {
    let cx: number, cy: number, bw: number, bh: number;
    let bestClass = -1, bestConf = -Infinity;

    if (isChannelsFirst) {
      cx = data[0 * numAnchors + a];
      cy = data[1 * numAnchors + a];
      bw = data[2 * numAnchors + a];
      bh = data[3 * numAnchors + a];
      for (let c = 0; c < NUM_CLASSES; c++) {
        const conf = data[(4 + c) * numAnchors + a];
        if (conf > bestConf) { bestConf = conf; bestClass = c; }
      }
    } else {
      const base = a * numChannels;
      cx = data[base + 0];
      cy = data[base + 1];
      bw = data[base + 2];
      bh = data[base + 3];
      for (let c = 0; c < NUM_CLASSES; c++) {
        const conf = data[base + 4 + c];
        if (conf > bestConf) { bestConf = conf; bestClass = c; }
      }
    }

    if (bestConf < threshold || bestClass < 0) continue;

    // Convert YOLO letterboxed centre+wh → top-left x,y in original image pixels
    const cxOrig = (cx - padX) / scale;
    const cyOrig = (cy - padY) / scale;
    const bwOrig = bw / scale;
    const bhOrig = bh / scale;

    const x = Math.max(0, Math.round(cxOrig - bwOrig / 2));
    const y = Math.max(0, Math.round(cyOrig - bhOrig / 2));
    const w = Math.min(origWidth  - x, Math.round(bwOrig));
    const h = Math.min(origHeight - y, Math.round(bhOrig));

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
  
  // Non-Maximum Suppression (NMS)
  const iouThreshold = 0.45;
  const finalResults: DetectionResult[] = [];
  
  for (const current of results) {
    let keep = true;
    for (const previous of finalResults) {
      if (current.label === previous.label) {
        const iou = calculateIoU(current.box, previous.box);
        if (iou > iouThreshold) {
          keep = false;
          break;
        }
      }
    }
    if (keep) {
      finalResults.push(current);
    }
  }

  console.info(`[Privexa/YOLO] ${finalResults.length} detections after NMS (threshold ${threshold})`);
  return finalResults;
}

function calculateIoU(box1: {x:number,y:number,width:number,height:number}, box2: {x:number,y:number,width:number,height:number}): number {
  const xA = Math.max(box1.x, box2.x);
  const yA = Math.max(box1.y, box2.y);
  const xB = Math.min(box1.x + box1.width, box2.x + box2.width);
  const yB = Math.min(box1.y + box1.height, box2.y + box2.height);

  const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
  if (interArea === 0) return 0;

  const box1Area = box1.width * box1.height;
  const box2Area = box2.width * box2.height;

  return interArea / (box1Area + box2Area - interArea);
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

      const { tensor, origWidth, origHeight, scale, padX, padY } = await preprocess(imageUrl);

      // Run inference — YOLO26 expects input named "images"
      let output: any;
      try {
        const feeds  = { images: tensor };
        output = await session.run(feeds);
      } catch (err: any) {
        throw new Error(`ONNX session.run failed. Tensor dims: ${tensor.dims.join('x')}. Err: ${err.message || String(err)}`);
      }

      // Dispose the input tensor immediately to free WASM heap memory
      tensor.dispose();

      // The primary detection output is typically named "output0"
      const rawOutput = output['output0'] ?? Object.values(output)[0];
      const results   = postprocess(rawOutput as ort.Tensor, origWidth, origHeight, scale, padX, padY, threshold);

      const durationMs = Math.round(performance.now() - startMs);

      self.postMessage({ type: 'DETECT_COMPLETE', results, durationMs });
    } catch (err: any) {
      console.error('[Privexa/vit] Inference failed:', err);
      // Send the FULL error stack back to the panel so it's visible in the UI
      self.postMessage({ type: 'DETECT_ERROR', error: err.stack || err.message || String(err) });
    }
    return;
  }
};
