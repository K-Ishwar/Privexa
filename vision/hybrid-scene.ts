import { type Scene, type Element as SceneElement, type VisionRegion } from '../shared/schema.js';

export interface VisualDetection {
  label: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
}

/**
 * Merges DOM-extracted elements with YOLO-detected visual bounding boxes
 * into a single unified hybrid Scene.
 * 
 * If a YOLO bounding box heavily overlaps an existing DOM element, it is discarded
 * to avoid duplicates. Otherwise, it is added to the scene as a generic interactive element.
 */
export function mergeHybridScene(
  domScene: Scene, 
  visualDetections: VisualDetection[],
  viewportWidth: number,
  viewportHeight: number
): Scene {
  
  const mergedElements: SceneElement[] = [...domScene.elements];

  for (const detection of visualDetections) {
    // 1. Convert YOLO box to viewport coordinates
    const box = {
      x: Math.max(0, Math.min(viewportWidth, Math.floor(detection.box.x))),
      y: Math.max(0, Math.min(viewportHeight, Math.floor(detection.box.y))),
      width: Math.floor(detection.box.width),
      height: Math.floor(detection.box.height)
    };

    // 2. Check for overlap with existing DOM elements (IoU)
    let hasOverlap = false;
    for (const domEl of mergedElements) {
      if (calculateIoU(box, domEl.box) > 0.4) {
        hasOverlap = true;
        break;
      }
    }

    // 3. If no significant overlap, it's a true "Gap" element discovered by YOLO!
    if (!hasOverlap) {
      // Map YOLO label to Privexa Role
      let role: SceneElement['role'] = 'TEXT';
      if (detection.label === 'button') role = 'BUTTON';
      if (detection.label === 'input' || detection.label === 'textarea') role = 'INPUT';
      if (detection.label === 'checkbox') role = 'CHECKBOX';

      mergedElements.push({
        id: randomUuid(),
        role,
        label: '[UNKNOWN_VISUAL]' as any,
        state: 'AVAILABLE',
        box
      });
    }
  }

  return {
    ...domScene,
    elements: mergedElements,
    privacy: {
      ...domScene.privacy,
      mode: 'HYBRID'
    }
  };
}

function calculateIoU(box1: any, box2: any): number {
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

function randomUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
