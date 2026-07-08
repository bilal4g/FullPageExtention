@echo off
REM ============================================================
REM  FullPage Studio - one-click library installer (Windows)
REM  Downloads the libraries needed for PDF rendering and
REM  offline math OCR into the lib\ folder. Run once.
REM  Just double-click this file.
REM ============================================================
setlocal
cd /d "%~dp0"
if not exist "lib" mkdir "lib"

echo.
echo FullPage Studio setup
echo Downloading libraries into lib\ ...
echo.

set PDF=https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js
set PDFWORKER=https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js
set TRANSFORMERS=https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/dist/transformers.min.js

echo [1/3] pdf.min.js
curl -L -o "lib\pdf.min.js" "%PDF%"
echo [2/3] pdf.worker.min.js
curl -L -o "lib\pdf.worker.min.js" "%PDFWORKER%"
echo [3/3] transformers.min.js
curl -L -o "lib\transformers.min.js" "%TRANSFORMERS%"

echo.
if exist "lib\pdf.min.js" if exist "lib\pdf.worker.min.js" if exist "lib\transformers.min.js" (
  echo Done. All libraries installed.
  echo Now go to chrome://extensions and click the reload icon on FullPage Studio.
) else (
  echo Something did not download. Check your internet connection and run again.
)
echo.
pause
