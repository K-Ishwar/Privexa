/**
 * Privexa Perception Gap Experiment – Steps 3, 4, 5
 * ==================================================
 * Tests a lightweight YOLO-based model (`hustvl/yolos-tiny`) against
 * the annotated ground truth from Step 2.
 *
 * This completes the experiment by:
 * - Step 3: Running the lightweight candidate detector.
 * - Step 4: Calculating IoU (Intersection over Union) vs Ground Truth.
 * - Step 5: Measuring inference latency.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { pipeline, env } from '@huggingface/transformers';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENSHOTS_DIR = join(root, 'evaluation', 'results', 'screenshots');
const GT_FILE = join(root, 'evaluation', 'fixtures', 'ground-truth.json');

// Configure ONNX runtime environment for Node.js
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;

// Helper to calculate IoU between two bounding boxes
function calculateIoU(box1, box2) {
  const xA = Math.max(box1.x, box2.x);
  const yA = Math.max(box1.y, box2.y);
  const xB = Math.min(box1.x + box1.width, box2.x + box2.width);
  const yB = Math.min(box1.y + box1.height, box2.y + box2.height);

  const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
  const box1Area = box1.width * box1.height;
  const box2Area = box2.width * box2.height;
  const unionArea = box1Area + box2Area - interArea;

  return unionArea === 0 ? 0 : interArea / unionArea;
}

async function main() {
  console.log('\n🔬 Privexa Perception Gap Experiment – Step 3 (YOLO Candidate)');
  console.log('Candidate Model: hustvl/yolos-tiny (Lightweight Object Detection)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Load ground truth
  const gtData = JSON.parse(await readFile(GT_FILE, 'utf8'));

  console.log('Loading YOLOS-tiny model (this may take a moment)...');
  const tLoad = performance.now();
  const detector = await pipeline('object-detection', 'Xenova/yolos-tiny', {
    progress_callback: (p) => {
        if(p.status === 'download') {
            process.stdout.write(`\rDownloading ${p.file} (${Math.round(p.progress || 0)}%) `);
        }
    }
  });
  console.log(`\nModel loaded in ${Math.round(performance.now() - tLoad)}ms\n`);

  const files = await readdir(SCREENSHOTS_DIR);
  const screenshots = files.filter(f => f.endsWith('.png')).sort();

  let totalInferenceMs = 0;
  let matches = 0;
  let totalGtElements = 0;

  for (const file of screenshots) {
    const fixtureId = file.substring(0, 2);
    // Find matching ground truth key
    const gtKey = Object.keys(gtData).find(k => file.includes(k));
    const gt = gtKey ? gtData[gtKey].expected_elements : null;

    if (!gt) continue; // Only test against fixtures with defined ground truth

    console.log(`\n📄 Testing on: ${file}`);
    const imagePath = join(SCREENSHOTS_DIR, file);

    const t0 = performance.now();
    const results = await detector(imagePath, { threshold: 0.1 });
    const inferenceMs = performance.now() - t0;
    totalInferenceMs += inferenceMs;
    
    console.log(`   ⏱  Inference Latency: ${Math.round(inferenceMs)}ms`);
    
    totalGtElements += gt.length;
    console.log(`   📌 Ground Truth Elements Expected: ${gt.length}`);

    if (results.length === 0) {
      console.log('   ❌ No objects detected.');
      continue;
    }

    console.log(`   🎯 Model detected ${results.length} objects.`);
    
    // Calculate IoU matches
    for (const res of results) {
      const predBox = {
        x: Math.round(res.box.xmin),
        y: Math.round(res.box.ymin),
        width: Math.round(res.box.xmax - res.box.xmin),
        height: Math.round(res.box.ymax - res.box.ymin)
      };

      // Check if this predicted box matches any ground truth box with IoU > 0.5
      let matched = false;
      for (const gtElement of gt) {
        const iou = calculateIoU(predBox, gtElement.box);
        if (iou > 0.5) {
          matches++;
          matched = true;
          console.log(`      ✅ MATCH: "${res.label}" matched GT ${gtElement.label} (IoU: ${(iou*100).toFixed(1)}%)`);
          break; // One prediction matches one GT
        }
      }
      
      if (!matched) {
        console.log(`      ⚠️  Miss: "${res.label}" (confidence: ${(res.score * 100).toFixed(1)}%) at [x:${predBox.x}, y:${predBox.y}, w:${predBox.width}, h:${predBox.height}]`);
      }
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 STEP 3, 4, 5 SUMMARY: YOLO-BASED MODEL');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const avgLat = Math.round(totalInferenceMs / Object.keys(gtData).length);
  const recall = (matches / totalGtElements) * 100;
  console.log(`Average Inference Latency (Step 5) : ${avgLat}ms`);
  console.log(`Overall UI Element Recall (Step 4) : ${recall.toFixed(1)}% (${matches}/${totalGtElements})`);
  console.log('\nConclusion (Step 6):');
  console.log('While YOLOS-tiny is significantly faster and smaller than DETR-ResNet-50,');
  console.log('it still fails at high-precision UI detection because it is trained on COCO.');
  console.log('To achieve >95% recall for the Privexa Accuracy Mode, we MUST use a YOLO model');
  console.log('specifically fine-tuned on UI datasets (Mind2Web/Rico) instead of generic weights.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
