# FullPage Studio

Full-page screenshot capture with a professional editing Studio and
**API-free, AI-readable math extraction**. Works in Chrome and Microsoft Edge
(Manifest V3).

## Flow

1. Click the toolbar icon → a small popup opens.
2. Choose **Capture full page** or **Capture visible area** (or use the keyboard
   shortcuts). The popup captures, then opens the **Studio** in a new browser
   tab with your screenshot already loaded.
3. Edit in the Studio, extract math for AI, and export.
4. **More settings** in the popup opens a full settings page in the browser.

## The Studio

A full-tab editor:

- Crop with aspect presets (1:1, 4:3, 16:9, 3:4, A4, free) and pixel-exact resize
- Rotate / flip
- Text, pen, arrow, rectangle, ellipse, highlighter
- Blur and redact (black box) for sensitive info
- Undo / redo, zoom / pan, keyboard shortcuts
- Export **PNG / JPG / WebP / PDF** at **1x / 2x / 4x / Max 8K**, plus copy to clipboard
- Drag-drop, paste, or open any image — not just captures

## Making math AI-readable (no API key)

The hard problem: hand an AI a screenshot full of equations and it often
misreads them, because rendered math is just pixels.

**The fix, with zero external services:** on almost every math site the real
equations are already in the page source — as **MathML**, **KaTeX**/**MathJax**
markup, LaTeX `annotation` nodes, or LaTeX in image `alt` text. At capture time
the content script reads those out of the DOM. The Studio's **✨ Math for AI**
panel lists them in reading order and builds a copy-paste bundle:

> The attached image is a screenshot. Its math equations, read directly from the
> page source, are listed below in reading order (LaTeX)…

You paste that alongside your image and the AI treats the LaTeX as ground truth.

Because this is pure DOM reading in the browser, there is **no API key, no cost,
and no per-user limit** — it scales to as many users as install the extension.

If a page bakes equations into flat images with no readable source, use
**Export at Max 8K** so the picture itself is sharp enough for the AI to read.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + Shift + S` | Capture visible area |
| `Ctrl/Cmd + Shift + F` | Capture full page |
| `V C T P A R O H B X` | Studio tools |
| `Ctrl/Cmd + Z` / `+ Shift + Z` | Undo / Redo |

## Load it (developer mode)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select this `fullpage` folder.
4. Pin the icon, open a page, and hit capture.

No build step required.
