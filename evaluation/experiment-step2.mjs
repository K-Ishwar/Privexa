/**
 * Privexa Perception Gap Experiment – Step 2
 * ============================================
 * Tests a candidate visual detector against the screenshots generated in Step 1.
 * We evaluate `Xenova/detr-resnet-50` (a COCO-trained DETR model) which was
 * previously proposed as a ViT-equivalent UI detector.
 *
 * This experiment tests the hypothesis: "Does a generic transformer-based
 * object detector actually recognize web UI elements (buttons, inputs)?"
 *
 * Output:
 *   Console output showing latency and detected labels.
 */

import { readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { pipeline, env } from '@huggingface/transformers';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCREENSHOTS_DIR = join(root, 'evaluation', 'results', 'screenshots');

// Configure ONNX runtime environment for Node.js
env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;

async function main() {
  console.log('\n🔬 Privexa Perception Gap Experiment – Step 2');
  console.log('Candidate Model: Xenova/detr-resnet-50 (Object Detection)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  console.log('Loading model (this may take a moment to download weights)...');
  const tLoad = performance.now();
  const detector = await pipeline('object-detection', 'Xenova/detr-resnet-50', {
    progress_callback: (p) => {
        if(p.status === 'download') {
            process.stdout.write(`\rDownloading ${p.file} (${Math.round(p.progress || 0)}%) `);
        }
    }
  });
  console.log(`\nModel loaded in ${Math.round(performance.now() - tLoad)}ms\n`);

  const files = await readdir(SCREENSHOTS_DIR);
  const screenshots = files.filter(f => f.endsWith('.png')).sort();

  if (screenshots.length === 0) {
    console.error('❌ No screenshots found. Run Step 1 first.');
    process.exit(1);
  }

  let totalInferenceMs = 0;

  for (const file of screenshots) {
    console.log(`\n📄 Testing on: ${file}`);
    const imagePath = join(SCREENSHOTS_DIR, file);

    const t0 = performance.now();
    const results = await detector(imagePath, { threshold: 0.1 });
    const inferenceMs = performance.now() - t0;
    totalInferenceMs += inferenceMs;

    console.log(`   ⏱  Inference: ${Math.round(inferenceMs)}ms`);

    if (results.length === 0) {
      console.log('   ❌ No objects detected above threshold.');
    } else {
      console.log(`   🎯 Detected ${results.length} objects:`);
      for (const res of results) {
        // Log the label, confidence, and bounding box
        console.log(`      - Label: "${res.label}" (confidence: ${(res.score * 100).toFixed(1)}%) | bbox: [x:${Math.round(res.box.xmin)}, y:${Math.round(res.box.ymin)}, w:${Math.round(res.box.xmax - res.box.xmin)}, h:${Math.round(res.box.ymax - res.box.ymin)}]`);
      }
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 STEP 2 SUMMARY');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Average Inference Latency: ${Math.round(totalInferenceMs / screenshots.length)}ms`);
  console.log('\nConclusion Evaluation:');
  console.log('Review the labels above. Did the model output "button", "input", or "checkbox"?');
  console.log('Or did it output COCO classes like "book", "tv", "cell phone"?');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
