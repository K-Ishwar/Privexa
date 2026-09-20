#!/usr/bin/env node
/**
 * Privexa – PII Precision & Recall Benchmark
 * ============================================
 * Tests the `replaceSensitive()` engine from shared/privacy.ts against a large
 * synthetic fixture set and emits a clean table of Precision / Recall / F1
 * numbers that can be cited directly in the SIH presentation.
 *
 * Usage:
 *   node evaluation/pii-benchmark.mjs
 *   # or via npm:
 *   npm run benchmark:pii
 *
 * The script does NOT use any network or cloud resources.
 * All fixture strings are 100% synthetic with no real personal data.
 */

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── Load shared privacy module via dynamic import ────────────────────────────
// We compile it on the fly using esbuild so we can import the TypeScript source.
import { createRequire } from 'node:module';
const require = createRequire(join(root, 'package.json'));
const { buildSync } = require('esbuild');
const tmpOut = join(root, 'evaluation', '.pii-bench-tmp.mjs');
buildSync({
  entryPoints: [join(root, 'shared', 'privacy.ts')],
  outfile: tmpOut,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
});
// Use pathToFileURL so Windows absolute paths become valid file:// URLs for ESM import()
const { replaceSensitive, classifyDomHints } = await import(pathToFileURL(tmpOut).href);

// ── Extended Synthetic Fixture ────────────────────────────────────────────────
// Each record: { id, text, labels[], domHints?, hard_negative }
// 'labels' lists which PII tags should appear in the output.
// 'NONE' means no PII tag should appear (hard-negative case).
const FIXTURES = [
  // ── Aadhaar ──────────────────────────────────────────────────────────────
  { id: 'aadhaar-plain',         text: '1234 5678 9012',            labels: ['[AADHAAR]'], hard_negative: false },
  { id: 'aadhaar-dashes',        text: '1234-5678-9012',            labels: ['[AADHAAR]'], hard_negative: false },
  { id: 'aadhaar-no-sep',        text: '123456789012',              labels: ['[AADHAAR]'], hard_negative: false },
  { id: 'aadhaar-in-sentence',   text: 'Your UID is 2345 6789 0123 — keep it safe', labels: ['[AADHAAR]'], hard_negative: false },
  { id: 'aadhaar-devanagari',    text: 'आधार: १२३४ ५६७८ ९०१२',       labels: ['[AADHAAR]'], hard_negative: false },
  { id: 'aadhaar-telugu',        text: 'ఆధార్: ౧౨౩౪ ౫౬౭౮ ౯౦౧౨',    labels: ['[AADHAAR]'], hard_negative: false },

  // ── PAN ──────────────────────────────────────────────────────────────────
  { id: 'pan-standard',          text: 'ABCDE1234F',                labels: ['[PAN]'],     hard_negative: false },
  { id: 'pan-lowercase',         text: 'abcde1234f',                labels: ['[PAN]'],     hard_negative: false },
  { id: 'pan-in-sentence',       text: 'My PAN is XYZPQ9999R',      labels: ['[PAN]'],     hard_negative: false },

  // ── Email ────────────────────────────────────────────────────────────────
  { id: 'email-simple',          text: 'user@example.com',          labels: ['[EMAIL]'],   hard_negative: false },
  { id: 'email-subdomain',       text: 'a.b+tag@mail.domain.co.in', labels: ['[EMAIL]'],   hard_negative: false },
  { id: 'email-in-sentence',     text: 'Contact us at support@privexa.example.invalid', labels: ['[EMAIL]'], hard_negative: false },

  // ── Phone ────────────────────────────────────────────────────────────────
  { id: 'phone-plus91',          text: '+91 98765 43210',           labels: ['[PHONE]'],   hard_negative: false },
  { id: 'phone-zero-prefix',     text: '09876543210',               labels: ['[PHONE]'],   hard_negative: false },
  { id: 'phone-spaces',          text: '9876 543 210',              labels: ['[PHONE]'],   hard_negative: false },
  { id: 'phone-dashes',          text: '98765-43210',               labels: ['[PHONE]'],   hard_negative: false },
  { id: 'phone-in-sentence',     text: 'Call us: +91-98765-43210',  labels: ['[PHONE]'],   hard_negative: false },

  // ── Password ─────────────────────────────────────────────────────────────
  { id: 'password-colon',        text: 'Password: Sup3rS3cr3t!',    labels: ['[PASSWORD]'], hard_negative: false },
  { id: 'passcode-equals',       text: 'passcode=1234abcd',         labels: ['[PASSWORD]'], hard_negative: false },

  // ── Name ─────────────────────────────────────────────────────────────────
  { id: 'name-full',             text: 'name: Rahul Sharma',        labels: ['[PERSON_NAME]'], hard_negative: false },
  { id: 'name-first',            text: 'first name: Priya',         labels: ['[PERSON_NAME]'], hard_negative: false },

  // ── Address ──────────────────────────────────────────────────────────────
  { id: 'address-colon',         text: 'address: 42 Demo Street, Example City', labels: ['[ADDRESS]'], hard_negative: false },

  // ── Hard Negatives (should NOT be flagged) ────────────────────────────────
  { id: 'neg-pan-label',         text: 'PAN card counter opens at 10 AM', labels: ['NONE'], hard_negative: true },
  { id: 'neg-short-code',        text: 'Help desk code: 1234',            labels: ['NONE'], hard_negative: true },
  { id: 'neg-field-label',       text: 'Full name (optional)',             labels: ['NONE'], hard_negative: true },
  { id: 'neg-currency',          text: 'Application fee: ₹1,200',         labels: ['NONE'], hard_negative: true },
  { id: 'neg-year',              text: 'Founded in 1947',                  labels: ['NONE'], hard_negative: true },
  { id: 'neg-pin-code',          text: 'PIN code: 110001',                 labels: ['NONE'], hard_negative: true },
  { id: 'neg-section-heading',   text: 'Section 80C deduction limit',      labels: ['NONE'], hard_negative: true },
];

// ── DOM Hint Fixtures (classifyDomHints) ──────────────────────────────────────
const DOM_FIXTURES = [
  { id: 'dom-aadhaar-name', hints: { kind: 'input', name: 'aadhaar', placeholder: 'Enter Aadhaar' }, expected: '[AADHAAR]' },
  { id: 'dom-pan-autocomplete', hints: { kind: 'input', autocomplete: 'off', name: 'panNumber' }, expected: '[PAN]' },
  { id: 'dom-email-type', hints: { kind: 'input', type: 'email', name: 'userEmail' }, expected: '[EMAIL]' },
  { id: 'dom-password-type', hints: { kind: 'input', type: 'password' }, expected: '[PASSWORD]' },
  { id: 'dom-phone-placeholder', hints: { kind: 'input', placeholder: 'Mobile number' }, expected: '[PHONE]' },
  { id: 'dom-address-name', hints: { kind: 'input', name: 'address', placeholder: 'Street address' }, expected: '[ADDRESS]' },
  { id: 'dom-continue-button', hints: { kind: 'button', text: 'Continue' }, expected: 'CONTINUE' },
  { id: 'dom-name-autocomplete', hints: { kind: 'input', autocomplete: 'name', placeholder: 'Full name' }, expected: '[PERSON_NAME]' },
];

// ── Evaluate replaceSensitive ─────────────────────────────────────────────────
console.log('\n🔬 Privexa — PII Precision & Recall Benchmark');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Engine: replaceSensitive() from shared/privacy.ts');
console.log(`Fixture count: ${FIXTURES.length} text records  |  ${DOM_FIXTURES.length} DOM-hint records\n`);

let tp = 0, fp = 0, fn = 0, tn = 0;
const failures = [];

for (const fixture of FIXTURES) {
  const result = replaceSensitive(fixture.text);
  const isNone = fixture.labels.includes('NONE');

  if (isNone) {
    // Hard negative: the output should contain NO [TAG] tokens at all
    const hasPiiTag = /\[(AADHAAR|PAN|EMAIL|PHONE|PASSWORD|PERSON_NAME|ADDRESS|PAYMENT)\]/.test(result);
    if (hasPiiTag) {
      fp++;
      failures.push({ id: fixture.id, type: 'FALSE_POSITIVE', input: fixture.text, output: result });
    } else {
      tn++;
    }
  } else {
    // Positive: each expected label must appear in the output
    for (const expectedTag of fixture.labels) {
      if (result.includes(expectedTag)) {
        tp++;
      } else {
        fn++;
        failures.push({ id: fixture.id, type: 'FALSE_NEGATIVE', input: fixture.text, output: result, expected: expectedTag });
      }
    }
  }
}

const precision = tp / (tp + fp) || 0;
const recall    = tp / (tp + fn) || 0;
const f1        = (2 * precision * recall) / (precision + recall) || 0;

// ── Evaluate classifyDomHints ─────────────────────────────────────────────────
let domCorrect = 0, domTotal = DOM_FIXTURES.length;
const domFailures = [];
for (const df of DOM_FIXTURES) {
  const got = classifyDomHints(df.hints);
  if (got === df.expected) {
    domCorrect++;
  } else {
    domFailures.push({ id: df.id, expected: df.expected, got });
  }
}
const domAccuracy = domCorrect / domTotal;

// ── Print Results ─────────────────────────────────────────────────────────────
console.log('┌─────────────────────────────────────────────────────────┐');
console.log('│           TEXT PII DETECTION (replaceSensitive)         │');
console.log('├────────────────────────┬────────────────────────────────┤');
console.log(`│  True  Positives (TP)  │  ${String(tp).padStart(4)}                          │`);
console.log(`│  False Positives (FP)  │  ${String(fp).padStart(4)}                          │`);
console.log(`│  True  Negatives (TN)  │  ${String(tn).padStart(4)}                          │`);
console.log(`│  False Negatives (FN)  │  ${String(fn).padStart(4)}                          │`);
console.log('├────────────────────────┼────────────────────────────────┤');
console.log(`│  Precision             │  ${(precision * 100).toFixed(1).padStart(5)}%                        │`);
console.log(`│  Recall                │  ${(recall * 100).toFixed(1).padStart(5)}%                        │`);
console.log(`│  F1 Score              │  ${(f1 * 100).toFixed(1).padStart(5)}%                        │`);
console.log('└────────────────────────┴────────────────────────────────┘');
console.log('');
console.log('┌─────────────────────────────────────────────────────────┐');
console.log('│           DOM HINT CLASSIFICATION (classifyDomHints)    │');
console.log('├────────────────────────┬────────────────────────────────┤');
console.log(`│  Correct               │  ${String(domCorrect).padStart(2)} / ${domTotal}                        │`);
console.log(`│  Accuracy              │  ${(domAccuracy * 100).toFixed(1).padStart(5)}%                        │`);
console.log('└────────────────────────┴────────────────────────────────┘');

if (failures.length > 0) {
  console.log('\n⚠️  TEXT DETECTION FAILURES:');
  for (const f of failures) {
    console.log(`  [${f.type}] ${f.id}`);
    console.log(`    Input : "${f.input}"`);
    console.log(`    Output: "${f.output}"${f.expected ? `  (expected: ${f.expected})` : ''}`);
  }
}
if (domFailures.length > 0) {
  console.log('\n⚠️  DOM CLASSIFICATION FAILURES:');
  for (const f of domFailures) {
    console.log(`  ${f.id}  expected=${f.expected}  got=${f.got}`);
  }
}

// ── Save report JSON ─────────────────────────────────────────────────────────
const report = {
  generated: new Date().toISOString(),
  text_pii: { tp, fp, tn, fn, precision, recall, f1, failures },
  dom_hints: { correct: domCorrect, total: domTotal, accuracy: domAccuracy, failures: domFailures },
};
const reportPath = join(root, 'evaluation', 'results', 'pii-benchmark-report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(`\n✅ Report saved → evaluation/results/pii-benchmark-report.json`);

// Clean up temp compiled file
try { await unlink(tmpOut); } catch {}

// Exit non-zero if quality gates not met
if (precision < 0.90 || recall < 0.90) {
  console.error('\n❌ Quality gate failed: Precision and Recall must both be ≥ 90%');
  process.exit(1);
}
console.log(`\n✅ Quality gate passed (Precision ≥ 90%, Recall ≥ 90%)\n`);
