import type { Scene } from "../shared/schema";

/**
 * The detector is deliberately lazy: merely importing this module does not load
 * a model, WASM, or inspect page content. `dataUrl` is decoded in memory and is
 * never returned or logged.
 */
let detectorPromise: Promise<any> | undefined;
let detector: any;
let fileset: any;

const MODEL_ASSET = "assets/vision/blaze_face_short_range.tflite";
const WASM_DIR = "assets/vision/wasm";

type Viewport = { width: number; height: number };
type Vision = Scene["vision"];
type VisionBox = Vision["regions"][number]["box"];

function unavailable(): Vision {
  return { status: "UNAVAILABLE", backend: "NONE", durationMs: 0, regions: [] } as Vision;
}

function asset(assetUrl: (path: string) => string, path: string): string {
  // assetUrl is supplied by the extension build; do not derive URLs from page
  // content and do not use a network fallback.
  return assetUrl(path);
}

async function getDetector(assetUrl: (path: string) => string): Promise<any> {
  if (detector) return detector;
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const vision = await import("@mediapipe/tasks-vision");
      fileset = await vision.FilesetResolver.forVisionTasks(asset(assetUrl, WASM_DIR));
      const instance = await vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: asset(assetUrl, MODEL_ASSET),
          delegate: "CPU",
        },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.5,
      });
      detector = instance;
      return instance;
    })().catch((error) => {
      detectorPromise = undefined;
      throw error;
    });
  }
  return detectorPromise;
}

async function decode(dataUrl: string): Promise<any> {
  // createImageBitmap is available in modern extension contexts. The fallback
  // keeps this usable from a panel document where Image is available.
  if (typeof createImageBitmap === "function") {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return createImageBitmap(blob);
  }
  if (typeof Image !== "undefined") {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("image decode failed"));
      image.src = dataUrl;
    });
  }
  throw new Error("no local image decoder available");
}

function integer(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function boxForDetection(raw: any, sourceWidth: number, sourceHeight: number, viewport: Viewport): VisionBox | undefined {
  const box = raw?.boundingBox;
  if (!box || !Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return undefined;
  const sx = viewport.width / sourceWidth;
  const sy = viewport.height / sourceHeight;
  const x = Number(box.originX);
  const y = Number(box.originY);
  const width = Number(box.width);
  const height = Number(box.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  // Clip in source pixels before scaling. Coordinates are integer CSS viewport
  // coordinates, matching the wire contract and avoiding confidence leakage.
  const left = Math.max(0, Math.min(sourceWidth, x));
  const top = Math.max(0, Math.min(sourceHeight, y));
  const right = Math.max(left, Math.min(sourceWidth, x + width));
  const bottom = Math.max(top, Math.min(sourceHeight, y + height));
  const vx = integer(left * sx, 0, 10000);
  const vy = integer(top * sy, 0, 10000);
  const vr = integer(right * sx, 0, 10000);
  const vb = integer(bottom * sy, 0, 10000);
  return { x: vx, y: vy, width: Math.max(0, Math.min(10000 - vx, vr - vx)), height: Math.max(0, Math.min(10000 - vy, vb - vy)) } as VisionBox;
}

/** Analyze a transient image and return enum-only visual regions. */
export async function analyzeVisual(dataUrl: string, viewport: Viewport, assetUrl: (path: string) => string): Promise<Vision> {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  let image: any;
  try {
    if (!dataUrl || !/^data:image\/(?:png|jpe?g|webp);base64,/i.test(dataUrl)) throw new Error("unsupported image input");
    if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || viewport.width < 1 || viewport.height < 1) throw new Error("invalid viewport");
    const d = await getDetector(assetUrl);
    image = await decode(dataUrl);
    const sourceWidth = Number(image.naturalWidth || image.width);
    const sourceHeight = Number(image.naturalHeight || image.height);
    const result = d.detect(image);
    const detections = Array.isArray(result?.detections) ? result.detections : [];
    const regions = detections.slice(0, 100).map((item: any) => boxForDetection(item, sourceWidth, sourceHeight, viewport)).filter(Boolean).map((box: VisionBox) => ({ label: "[PERSON_IMAGE]", box }));
    const durationMs = Math.max(0, Math.min(120000, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - started)));
    return { status: "READY", backend: "WASM", durationMs, regions } as Vision;
  } catch {
    const durationMs = Math.max(0, Math.min(120000, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - started)));
    return { status: "UNAVAILABLE", backend: "NONE", durationMs, regions: [] } as Vision;
  } finally {
    try { image?.close?.(); } catch { /* best effort */ }
  }
}

/** Release detector and WASM resources; safe to call repeatedly. */
export async function releaseVision(): Promise<void> {
  const current = detector;
  detector = undefined;
  detectorPromise = undefined;
  fileset = undefined;
  try { current?.close?.(); } catch { /* best effort */ }
}

export { extractTextFromImage } from './ocr';
