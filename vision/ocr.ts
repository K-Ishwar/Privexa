/**
 * OCR module — disabled until Tesseract assets are bundled locally.
 * The extension CSP blocks CDN fetches, so we silently return empty string
 * instead of crashing. YOLO handles visual element detection.
 */

export async function extractTextFromImage(
  _dataUrl: string,
  _assetUrl: (path: string) => string
): Promise<string> {
  // Tesseract.js requires large language data files (~30MB) to be bundled locally.
  // Until those assets are installed via `npm run setup:vision`, OCR is a no-op.
  // This prevents the "Failed to load tesseract worker" console errors.
  return '';
}
