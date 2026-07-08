@echo off
REM ============================================================
REM  FullPage Studio - one-time asset setup (Windows)
REM  Downloads the offline math-OCR model + pdf.js into vendor\.
REM  No API keys. Everything runs locally afterwards.
REM  Requires: Node.js 18+ (for npm).
REM ============================================================
setlocal
cd /d "%~dp0"

echo.
echo === FullPage Studio: fetching offline assets ===
echo.

if not exist vendor mkdir vendor
if not exist vendor\models mkdir vendor\models

REM --- Transformers.js (browser UMD build) + ONNX WASM runtime ---
call npm pack @xenova/transformers@2.17.2
for %%f in (xenova-transformers-*.tgz) do tar -xzf "%%f"
copy /Y package\dist\transformers.min.js vendor\transformers.min.js
copy /Y package\dist\*.wasm vendor\
copy /Y package\dist\ort-wasm*.* vendor\ 2>nul

REM --- pdf.js (module build + worker) ---
call npm pack pdfjs-dist@4.6.82
for %%f in (pdfjs-dist-*.tgz) do tar -xzf "%%f"
copy /Y package\build\pdf.min.mjs vendor\pdf.min.mjs
copy /Y package\build\pdf.worker.min.mjs vendor\pdf.worker.min.mjs

REM --- Math OCR model (image -> LaTeX). Downloaded via Transformers.js cache. ---
echo.
echo Downloading the image-to-LaTeX model into vendor\models ...
node fetch-model.mjs

REM --- cleanup ---
rmdir /S /Q package 2>nul
del /Q xenova-transformers-*.tgz 2>nul
del /Q pdfjs-dist-*.tgz 2>nul

echo.
echo === Done. Reload the extension at chrome://extensions ===
echo.
endlocal
