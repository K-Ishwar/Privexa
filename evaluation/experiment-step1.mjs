/**
 * Privexa Perception Gap Experiment – Step 1
 * ============================================
 * Uses Playwright + the built dist/chrome/content.js to run the real DOM scanner
 * against each fixture page. Captures screenshots and records exactly what the
 * pipeline found and what it missed.
 *
 * Output:
 *   evaluation/results/step1-dom-scan-results.json   — full structured results
 *   evaluation/results/screenshots/NN-*.png          — viewport screenshot per fixture
 *
 * Usage:
 *   npm run build            (build content.js first)
 *   node evaluation/experiment-step1.mjs
 */

import { createRequire } from 'node:module';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'node_modules', '../package.json'));
const { chromium } = require('playwright');

const DIST = process.env.PRIVEXA_DIST || join(root, 'dist');
const CONTENT_JS = join(DIST, 'chrome', 'content.js');
const FIXTURES_DIR = join(root, 'evaluation', 'fixtures');
const RESULTS_DIR = join(root, 'evaluation', 'results');
const SCREENSHOTS_DIR = join(RESULTS_DIR, 'screenshots');

// ── Fixture definitions ────────────────────────────────────────────────────
// For each fixture we define:
//   - What the DOM scanner *should* find (ground truth element counts/types)
//   - Whether we expect visualFallbackNeeded to be true
//   - The "critical gap" — what we expect the DOM to MISS
const FIXTURES = [
  {
    id: '01',
    name: 'Standard HTML Form',
    file: '01-html-form.html',
    expectedVisualFallback: false,
    groundTruth: {
      inputs: 5,        // name, email, phone, aadhaar, pan
      selects: 1,       // state
      checkboxes: 1,    // consent
      buttons: 1,       // Continue
      links: 0,
    },
    knownGap: 'None expected — fully DOM-based page.',
  },
  {
    id: '02',
    name: 'Login Page',
    file: '02-login-page.html',
    expectedVisualFallback: false,
    groundTruth: {
      inputs: 2,        // email, password
      selects: 0,
      checkboxes: 0,
      buttons: 1,       // Continue
      links: 2,         // forgot password, create account
    },
    knownGap: 'None expected — fully DOM-based page.',
  },
  {
    id: '03',
    name: 'E-Commerce Checkout',
    file: '03-ecommerce-checkout.html',
    expectedVisualFallback: true,   // product IMG present
    groundTruth: {
      inputs: 9,        // name×2, address, city, pin, phone, card, expiry, cvv
      selects: 0,
      checkboxes: 0,
      buttons: 1,       // Review Order
      links: 0,
      images: 1,        // product thumbnail (IMG tag)
    },
    knownGap: 'Product image text is in alt/pixels, not DOM text. DOM sees IMG but not its visual content.',
  },
  {
    id: '04',
    name: 'React SPA (Role-based elements)',
    file: '04-react-spa.html',
    expectedVisualFallback: false,
    groundTruth: {
      inputs: 2,        // name, email inputs
      textareas: 1,     // issue description (counted as INPUT)
      selects: 0,
      checkboxes: 1,    // div role="checkbox"
      buttons: 4,       // 2 nav spans + Next + Cancel (all role="button")
      links: 0,
    },
    knownGap: 'Depends on whether roleAndKind() detects role="button" on div and role="checkbox" on div.',
  },
  {
    id: '05',
    name: 'Canvas-Only Form (CRITICAL GAP)',
    file: '05-canvas-form.html',
    expectedVisualFallback: true,   // canvas present
    groundTruth: {
      // DOM scanner sees only the <canvas> tag itself
      inputs: 0,
      selects: 0,
      checkboxes: 0,
      buttons: 0,
      // What EXISTS visually but DOM cannot find:
      visualOnly: {
        inputs: 4,      // Name, Aadhaar, Mobile, Address, City, PIN drawn on canvas
        checkboxes: 1,  // Drawn checkbox
        buttons: 2,     // Back and Continue drawn on canvas
      },
    },
    knownGap: 'CRITICAL: All form elements drawn on canvas. DOM scanner finds <canvas> tag only. ' +
              'Visual model needed for Back/Continue button coordinates.',
  },
  {
    id: '06',
    name: 'Mixed DOM + Canvas',
    file: '06-mixed-dom-canvas.html',
    expectedVisualFallback: true,
    groundTruth: {
      // DOM section: name, email, phone, verification code input, Continue button
      inputs: 4,
      selects: 0,
      checkboxes: 0,
      buttons: 1,
      // Canvas sections DOM cannot interpret:
      visualOnly: {
        canvases: 2,    // signature pad + captcha
        textInPixels: 'X7R2P captcha code — only OCR/ViT can read this',
      },
    },
    knownGap: 'Signature pad and captcha text exist only in canvas pixels. OCR could read captcha. ' +
              'DOM handles name/email/phone/button fine.',
  },
  {
    id: '07',
    name: 'AI Chat Interface',
    file: '07-ai-chat.html',
    expectedVisualFallback: false,
    groundTruth: {
      inputs: 1,        // textarea
      selects: 0,
      checkboxes: 0,
      buttons: 5,       // send button + 4 suggestion chips (role="button")
      links: 0,
    },
    knownGap: 'None expected IF role="button" on div chips are detected. ' +
              'This tests ARIA role support in content.ts.',
  },
  {
    id: '08',
    name: 'Banking Portal',
    file: '08-banking-portal.html',
    expectedVisualFallback: false,
    groundTruth: {
      inputs: 5,        // amount, account, ifsc, name, remarks
      selects: 1,       // from account
      checkboxes: 0,
      buttons: 2,       // Back, Review
      links: 4,         // nav links
    },
    knownGap: 'None expected — fully DOM-based. Tests financial form accuracy.',
  },
  {
    id: '09',
    name: 'Image with PII in Pixels',
    file: '09-image-with-pii.html',
    expectedVisualFallback: true,
    groundTruth: {
      inputs: 2,        // aadhaar last 4, date
      selects: 0,
      checkboxes: 0,
      buttons: 1,       // Next
      // Canvas/image PII that DOM CANNOT find:
      visualOnly: {
        pixelPii: [
          'Name: Rahul Kumar Example (canvas)',
          'DOB: 15/08/1990 (canvas)',
          'Aadhaar: 1234 5678 9012 (canvas)',
          'Person face (canvas)',
        ],
      },
    },
    knownGap: 'CRITICAL: Aadhaar number, name, DOB drawn in canvas pixels. ' +
              'DOM scanner cannot see this PII. This is the privacy leak gap that OCR + NER would close.',
  },
  {
    id: '10',
    name: 'PDF-like Document',
    file: '10-pdf-document.html',
    expectedVisualFallback: false,
    groundTruth: {
      inputs: 0,        // no form inputs — it is a read-only document
      selects: 0,
      checkboxes: 0,
      buttons: 0,
      // PII is in DOM text nodes (field-value divs), readable by DOM scanner
      domPii: [
        'Rahul Kumar Example (TEXT node)',
        'ABCDE0000F (PAN in TEXT node)',
        '1234 5678 9012 (Aadhaar in TEXT node)',
        '+91 00000 00000 (phone in TEXT node)',
        'rahul.example@example.invalid (email in TEXT node)',
      ],
    },
    knownGap: 'None for DOM — PII is in DOM text nodes and should be found by NER/regex. ' +
              'For real Chrome PDF viewer: entire page would be canvas, making this a gap. ' +
              'This fixture tests HTML-rendered-PDF scenario.',
  },
];

// ── Playwright harness helper ──────────────────────────────────────────────
async function installContentScript(page, contentJsPath) {
  // Simulate the Chrome runtime.onMessage that content.ts expects
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        onMessage: {
          addListener(fn) { window.__privexaListener = fn; },
        },
      },
    };
    window.ask = (m) =>
      new Promise((resolve) => window.__privexaListener(m, {}, resolve));
  });
  await page.addScriptTag({ path: contentJsPath });
}

async function runScan(page) {
  return page.evaluate(() =>
    window.ask({ type: 'PRIVEXA_SCAN', goal: 'NEXT_STEP', nlpEnabled: false })
  );
}

// ── Per-fixture analysis ───────────────────────────────────────────────────
function analyzeResult(fixture, scanResult, durationMs) {
  const { scene, local } = scanResult;
  const elements = scene?.elements ?? [];

  // Count by role
  const roleCount = {};
  for (const e of elements) {
    roleCount[e.role] = (roleCount[e.role] ?? 0) + 1;
  }

  // Collect all labels (redacted vs safe)
  const piiLabels = elements.filter(e => e.label.startsWith('[')).map(e => e.label);
  const safeLabels = elements.filter(e => !e.label.startsWith('[')).map(e => e.label);

  // Gap detection: visualFallbackNeeded tells us DOM scanner knows it hit a visual element
  const detectedGap = local?.visualFallbackNeeded ?? false;
  const expectedGap = fixture.expectedVisualFallback;
  const gapDetectionCorrect = detectedGap === expectedGap;

  // Compare against ground truth input count
  const gt = fixture.groundTruth;
  const foundInputs = (roleCount['INPUT'] ?? 0);
  const foundButtons = (roleCount['BUTTON'] ?? 0);
  const foundSelects = (roleCount['SELECT'] ?? 0);
  const foundCheckboxes = (roleCount['CHECKBOX'] ?? 0);
  const foundImages = (roleCount['IMAGE'] ?? 0);
  const foundLinks = (roleCount['LINK'] ?? 0);

  const inputDelta = foundInputs - (gt.inputs ?? 0);
  const buttonDelta = foundButtons - (gt.buttons ?? 0);

  return {
    fixtureId: fixture.id,
    fixtureName: fixture.name,
    durationMs: Math.round(durationMs),
    totalElementsFound: elements.length,
    roleBreakdown: roleCount,
    piiLabels,
    safeLabels,
    visualFallbackNeeded: detectedGap,
    expectedVisualFallback: expectedGap,
    gapDetectionCorrect,
    groundTruthComparison: {
      inputs:    { expected: gt.inputs ?? 0,    found: foundInputs,    delta: inputDelta },
      buttons:   { expected: gt.buttons ?? 0,   found: foundButtons,   delta: buttonDelta },
      selects:   { expected: gt.selects ?? 0,   found: foundSelects,   delta: foundSelects - (gt.selects ?? 0) },
      checkboxes:{ expected: gt.checkboxes ?? 0,found: foundCheckboxes,delta: foundCheckboxes - (gt.checkboxes ?? 0) },
      images:    { expected: gt.images ?? 0,    found: foundImages,    delta: foundImages - (gt.images ?? 0) },
      links:     { expected: gt.links ?? 0,     found: foundLinks,     delta: foundLinks - (gt.links ?? 0) },
    },
    knownGapDescription: fixture.knownGap,
    visualOnlyElements: fixture.groundTruth.visualOnly ?? null,
    domPii: fixture.groundTruth.domPii ?? null,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  // Ensure output directories exist
  await mkdir(RESULTS_DIR, { recursive: true });
  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  // Verify content.js was built
  try {
    await readFile(CONTENT_JS);
  } catch {
    console.error(`\n❌ ERROR: ${CONTENT_JS} not found.\n   Run: npm run build\n`);
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const results = [];
  const summary = {
    totalFixtures: FIXTURES.length,
    gapDetectionAccuracy: 0,
    fixturesWithVisualGap: 0,
    fixturesWithNoGap: 0,
    averageScanMs: 0,
    criticalGaps: [],
  };

  console.log('\n🔬 Privexa Perception Gap Experiment – Step 1');
  console.log('━'.repeat(60));

  for (const fixture of FIXTURES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const fixturePath = join(FIXTURES_DIR, fixture.file);

    try {
      console.log(`\n📄 [${fixture.id}] ${fixture.name}`);

      // Navigate to the fixture HTML
      await page.goto(`file://${fixturePath}`, { waitUntil: 'networkidle' });

      // Wait a moment for canvas scripts to execute
      await page.waitForTimeout(300);

      // Take screenshot BEFORE injecting the content script
      const screenshotPath = join(SCREENSHOTS_DIR, `${fixture.id}-${fixture.file.replace('.html', '')}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.log(`   📸 Screenshot saved: results/screenshots/${fixture.id}-*.png`);

      // Install content script and run scan
      await installContentScript(page, CONTENT_JS);
      const t0 = performance.now();
      const scanResult = await runScan(page);
      const durationMs = performance.now() - t0;

      // Analyze
      const analysis = analyzeResult(fixture, scanResult, durationMs);
      results.push(analysis);

      // Console summary
      console.log(`   ⏱  Scan: ${analysis.durationMs}ms`);
      console.log(`   🔢 Elements found: ${analysis.totalElementsFound} | Roles: ${JSON.stringify(analysis.roleBreakdown)}`);
      console.log(`   👁  visualFallbackNeeded: ${analysis.visualFallbackNeeded} (expected: ${analysis.expectedVisualFallback}) ${analysis.gapDetectionCorrect ? '✅' : '❌'}`);

      if (analysis.piiLabels.length > 0) {
        console.log(`   🔒 PII labels (redacted): ${[...new Set(analysis.piiLabels)].join(', ')}`);
      }

      // Input delta warnings
      const { inputs, buttons } = analysis.groundTruthComparison;
      if (inputs.delta !== 0) {
        console.log(`   ⚠️  INPUT delta: expected ${inputs.expected}, found ${inputs.found} (Δ${inputs.delta > 0 ? '+' : ''}${inputs.delta})`);
      }
      if (buttons.delta !== 0) {
        console.log(`   ⚠️  BUTTON delta: expected ${buttons.expected}, found ${buttons.found} (Δ${buttons.delta > 0 ? '+' : ''}${buttons.delta})`);
      }

      if (analysis.visualFallbackNeeded) {
        summary.fixturesWithVisualGap++;
        if (analysis.visualOnlyElements) {
          summary.criticalGaps.push({
            fixture: `[${fixture.id}] ${fixture.name}`,
            visualOnly: analysis.visualOnlyElements,
          });
        }
      } else {
        summary.fixturesWithNoGap++;
      }

      if (analysis.gapDetectionCorrect) summary.gapDetectionAccuracy++;
      summary.averageScanMs += analysis.durationMs;

    } catch (err) {
      console.error(`   ❌ ERROR: ${err.message}`);
      results.push({
        fixtureId: fixture.id,
        fixtureName: fixture.name,
        error: err.message,
      });
    } finally {
      await page.close();
    }
  }

  await browser.close();

  // Finalize summary
  summary.gapDetectionAccuracy = `${summary.gapDetectionAccuracy}/${FIXTURES.length}`;
  summary.averageScanMs = Math.round(summary.averageScanMs / FIXTURES.length);

  const output = {
    experimentVersion: '1.0',
    runAt: new Date().toISOString(),
    description: 'Step 1: DOM scan gap analysis across 10 representative page types. ' +
                 'Records what the existing DOM+OCR pipeline finds and where it is blind.',
    summary,
    fixtures: results,
  };

  const outputPath = join(RESULTS_DIR, 'step1-dom-scan-results.json');
  await writeFile(outputPath, JSON.stringify(output, null, 2));

  // Print final summary table
  console.log('\n' + '━'.repeat(60));
  console.log('📊 EXPERIMENT SUMMARY');
  console.log('━'.repeat(60));
  console.log(`Gap detection accuracy : ${summary.gapDetectionAccuracy}`);
  console.log(`Pages with visual gap  : ${summary.fixturesWithVisualGap}`);
  console.log(`Pages DOM-sufficient   : ${summary.fixturesWithNoGap}`);
  console.log(`Average scan latency   : ${summary.averageScanMs}ms`);

  if (summary.criticalGaps.length > 0) {
    console.log('\n🚨 CRITICAL VISUAL GAPS (elements DOM cannot find):');
    for (const gap of summary.criticalGaps) {
      console.log(`   ${gap.fixture}`);
      console.log(`   → ${JSON.stringify(gap.visualOnly)}`);
    }
  }

  console.log(`\n✅ Results written to: evaluation/results/step1-dom-scan-results.json`);
  console.log('📸 Screenshots in    : evaluation/results/screenshots/\n');
  console.log('Next step: Annotate ground-truth bounding boxes using the screenshots,');
  console.log('then run Step 2 to test candidate visual detectors against those boxes.\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
