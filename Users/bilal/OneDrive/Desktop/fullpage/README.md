# FullPage Studio

Full-page screenshot capture and a professional editing Studio for Chromium
browsers (Chrome / Microsoft Edge). Captures a page, lets you edit it like a
lightweight Photopea, and hands **clean, machine-readable math** to any AI
without a single API key.

## How it works

1. **Simple popup** – click the toolbar icon for a small popup with two buttons:
   *Capture full page* and *Capture visible area*, plus *Open Studio* and
   *Settings*.
2. **Capture opens the Studio** – after a capture the full-screen Studio opens
   in a browser tab with the screenshot already loaded.
3. **Edit** – crop (with size presets), resize, rotate/flip, text, pen, arrow,
   rectangle, ellipse, highlighter, blur and redact, with undo/redo, zoom and
   pan.
4. **Export** – PNG / JPG / WebP / PDF, copy to clipboard, or **Export
   segments** for long pages.

## The math problem, solved without an API

AIs struggle to read equations in a tall, downscaled screenshot because they
cannot zoom in. FullPage Studio fixes this with **zero external services**, so
it scales to any number of users at no cost:

- **Equation extraction from the page HTML.** The content script reads real
  math markup already in the page – MathML, MathJax, KaTeX, `data-latex`, and
  ARIA labels – and turns it into LaTeX + plain text. This is exact, not OCR
  guessing.
- **Copy as AI prompt.** One click bundles those equations into a prompt you
  paste alongside the screenshot, so the model reads the actual math.
- **Segment export.** For image-only math, the capture is sliced into readable
  vertical segments plus a JSON manifest, so every equation reaches the AI at
  full resolution instead of shrunk into one giant image.

There are **no API keys, no accounts, and no network calls** for math. Delivery
is configurable in Settings (equation text + image, text only, or image only).

## Settings page

A full settings page opens in its own browser tab (extension options page).
It controls default export format, export scale, theme, how math is handed to
the AI, and long-page segmentation.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + Shift + S` | Capture visible area |
| `Ctrl/Cmd + Shift + F` | Capture full page |
| `V` | Move / pan |
| `C` | Crop |
| `T` | Text |
| `P` | Pen |
| `A` | Arrow |
| `R` | Rectangle |
| `O` | Ellipse |
| `H` | Highlighter |
| `B` | Blur |
| `X` | Redact |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` | Redo |

## Install (developer / unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** and select the `fullpage` folder.
4. Click the icon, capture a page, and the Studio opens with your capture.

No build step and no dependencies are required to run it unpacked.
