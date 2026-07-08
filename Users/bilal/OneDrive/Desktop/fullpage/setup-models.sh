#!/usr/bin/env bash
# ============================================================
#  FullPage Studio - one-time asset setup (macOS / Linux)
#  Downloads the offline math-OCR model + pdf.js into vendor/.
#  No API keys. Everything runs locally afterwards.
#  Requires: Node.js 18+ (for npm).
# ============================================================
set -e
cd "$(dirname "$0")"

echo
echo "=== FullPage Studio: fetching offline assets ==="
echo

mkdir -p vendor/models

# --- Transformers.js (browser build) + ONNX WASM runtime ---
npm pack @xenova/transformers@2.17.2
tar -xzf xenova-transformers-*.tgz
cp -f package/dist/transformers.min.js vendor/transformers.min.js
cp -f package/dist/*.wasm vendor/ 2>/dev/null || true
cp -f package/dist/ort-wasm*.* vendor/ 2>/dev/null || true

# --- pdf.js (module build + worker) ---
npm pack pdfjs-dist@4.6.82
tar -xzf pdfjs-dist-*.tgz
cp -f package/build/pdf.min.mjs vendor/pdf.min.mjs
cp -f package/build/pdf.worker.min.mjs vendor/pdf.worker.min.mjs

# --- Math OCR model (image -> LaTeX) ---
echo
echo "Downloading the image-to-LaTeX model into vendor/models ..."
node fetch-model.mjs

# --- cleanup ---
rm -rf package
rm -f xenova-transformers-*.tgz pdfjs-dist-*.tgz

echo
echo "=== Done. Reload the extension at chrome://extensions ==="
echo
