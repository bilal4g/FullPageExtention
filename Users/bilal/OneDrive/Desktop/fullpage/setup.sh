#!/usr/bin/env bash
# ============================================================
#  FullPage Studio - one-click library installer (mac/Linux)
#  Downloads the libraries needed for PDF rendering and
#  offline math OCR into the lib/ folder. Run once:
#      bash setup.sh
# ============================================================
set -e
cd "$(dirname "$0")"
mkdir -p lib

PDF="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js"
PDFWORKER="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js"
TRANSFORMERS="https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/dist/transformers.min.js"

echo "FullPage Studio setup - downloading libraries into lib/ ..."
echo "[1/3] pdf.min.js";        curl -L -o lib/pdf.min.js "$PDF"
echo "[2/3] pdf.worker.min.js"; curl -L -o lib/pdf.worker.min.js "$PDFWORKER"
echo "[3/3] transformers.min.js"; curl -L -o lib/transformers.min.js "$TRANSFORMERS"

if [ -f lib/pdf.min.js ] && [ -f lib/pdf.worker.min.js ] && [ -f lib/transformers.min.js ]; then
  echo "Done. All libraries installed."
  echo "Now open chrome://extensions and click the reload icon on FullPage Studio."
else
  echo "Something did not download. Check your connection and run again."
fi
