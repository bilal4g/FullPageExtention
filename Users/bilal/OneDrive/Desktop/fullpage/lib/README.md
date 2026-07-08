# Vendored libraries (drop-in)

Two optional features rely on well-known open-source libraries. They are not
committed here because they are large/binary; drop the files into this `lib/`
folder and the features light up automatically. Everything still runs 100%
locally — no API keys, no accounts.

## 1) PDF support  (open & capture PDFs in the Studio)

Download pdf.js (Mozilla) and place these two files here:

```
lib/pdf.min.js
lib/pdf.worker.min.js
```

Get them from: https://github.com/mozilla/pdf.js/releases (the "pdfjs-dist"
legacy build). Rename `pdf.min.mjs` / `pdf.worker.min.mjs` to `.js` if needed,
or use the `legacy/build/pdf.js` + `pdf.worker.js` files. Once present, the
Studio's **Open** button and drag-drop accept `.pdf` and render every page onto
the canvas so you can crop, annotate and export.

## 2) Offline math OCR  (read math baked into images)

Download transformers.js and place it here:

```
lib/transformers.min.js
```

Get it from: https://github.com/huggingface/transformers.js (the
`dist/transformers.min.js` ESM build) or npm `@huggingface/transformers`.

The model itself is downloaded once from the Hugging Face CDN and cached in the
browser — no API key, no per-user cost. Default model is `Xenova/nougat-small`
(document + math OCR). You can change it in **Settings → OCR model** to any
transformers.js-compatible image-to-text model.

> First run downloads the model (tens of MB) and may take a moment; afterwards
> it is cached and fast. If `lib/transformers.min.js` is absent, the Studio
> falls back to the API-free DOM math extraction + high-res 8K export.
