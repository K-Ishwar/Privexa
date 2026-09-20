# Local visual analysis

`index.ts` exports:

- `analyzeVisual(dataUrl, viewport, assetUrl)` — runs the locally packaged MediaPipe FaceDetector and returns only `[PERSON_IMAGE]` regions with integer CSS-viewport boxes.
- `releaseVision()` — closes the detector and releases resources.

The input data URL is decoded transiently in memory. It is never logged, returned, sent to a server, OCR'd, or persisted. Detection confidence, landmarks, image pixels, and model output metadata are not part of the result. A face detection means only that a face-like region was detected; it does **not** assert a person's identity. This implementation does not implement OCR, text-in-image recognition, NER, or arbitrary image classification.

## Assets and build

The extension bundle must supply an `assetUrl(path)` that resolves packaged extension assets. The expected paths are:

- `assets/vision/blaze_face_short_range.tflite`
- `assets/vision/wasm/` (both JavaScript loaders and WASM binaries shipped by `@mediapipe/tasks-vision`)

The model source is `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`. Setup saves these model bytes locally as `blaze_face_short_range.tflite`; the runtime reads the model bytes regardless of that local filename.

Install the exact runtime dependency in the project build environment:

```sh
npm install --save-exact @mediapipe/tasks-vision@0.10.22-rc.20250304
```

Then, from the repository root, explicitly consent to the model download on the user machine:

```sh
node vision/setup-assets.mjs --download
```

Without `--download`, setup performs no network access and changes no assets. The setup script downloads the pinned Google-hosted MediaPipe face detector model, copies WASM runtime files from the installed package, and writes `extension/assets/vision/SHA256SUMS.json`. The hashes are computed locally after download and are provenance records, not independent authenticity verification. No remote script or model URL is used at runtime.

## Limitations and failure behavior

- `analyzeVisual` uses the CPU delegate and reports `backend: "WASM"` only after a successful inference. Missing assets, unsupported decoders, invalid input, and detector failures fail closed as `UNAVAILABLE` with no regions.
- The image is assumed to correspond to the supplied viewport. Bounding boxes are clipped to source image dimensions and scaled from actual decoded image dimensions to CSS viewport coordinates; they are capped at the wire contract's integer bounds.
- At most 100 regions are returned. Detector initialization is lazy an