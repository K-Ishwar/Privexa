#!/usr/bin/env node
/**
 * Prepare local, offline vision assets. This script intentionally performs no
 * download unless --download is explicitly supplied by the user.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "extension", "assets", "vision");
const WASM_OUT = join(OUT, "wasm");
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const MODEL_FILE = join(OUT, "blaze_face_short_range.tflite");
const VERSION = "0.10.22-rc.20250304";

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status})`);
  await mkdir(dirname(destination), { recursive: true });
  await pipeline(response.body, createWriteStream(destination));
}
async function findPackage() {
  const candidates = [
    join(ROOT, "node_modules", "@mediapipe", "tasks-vision"),
    join(process.cwd(), "node_modules", "@mediapipe", "tasks-vision"),
  ];
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isDirectory()) return candidate; } catch { /* next */ }
  }
  throw new Error("@mediapipe/tasks-vision is not installed; install exactly version " + VERSION);
}
async function copyWasm(packageRoot) {
  const source = join(packageRoot, "wasm");
  const files = await readdir(source);
  const wasm = files.filter((name) => name.endsWith(".wasm") || name.endsWith(".js"));
  if (!wasm.length) throw new Error(`no WASM runtime files found in ${source}`);
  await mkdir(WASM_OUT, { recursive: true });
  for (const name of wasm) await copyFile(join(source, name), join(WASM_OUT, name));
  return wasm;
}

if (!process.argv.includes("--download")) {
  console.log("No files downloaded. Re-run with --download to consent to the pinned Google model download.");
  process.exit(0);
}
try {
  const packageRoot = await findPackage();
  const wasmFiles = await copyWasm(packageRoot);
  await download(MODEL_URL, MODEL_FILE);
  const manifest = {
    generatedAt: new Date().toISOString(),
    model: { file: "blaze_face_short_range.tflite", url: MODEL_URL, sha256: await sha256(MODEL_FILE), provenance: "SHA256 computed locally after download; not independently verified." },
    wasm: { package: "@mediapipe/tasks-vision", version: VERSION, files: Object.fromEntries(await Promise.all(wasmFiles.map(async (name) => [name, await sha256(join(WASM_OUT, name))]))) },
  };
  await writeFile(join(OUT, "SHA256SUMS.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Prepared ${wasmFiles.length} WASM file(s), model, and SHA256SUMS.json under ${OUT}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}