/* Downloads the image->LaTeX OCR model into ./vendor/models so it can run
 * fully offline via Transformers.js. Run by setup-models.cmd / .sh.
 * No API key required - these are public model weights on the HF CDN. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MODEL = 'Xenova/texify';           // image-to-text (LaTeX) ONNX model
const BASE = `https://huggingface.co/${MODEL}/resolve/main`;
const OUT = join(process.cwd(), 'vendor', 'models', MODEL);

// Files Transformers.js expects for an image-to-text ONNX model.
const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
];

async function dl(rel) {
  const url = `${BASE}/${rel}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed ${rel}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = join(OUT, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`  ok  ${rel} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

const args = process.argv.slice(2);
const modelArg = args.find((a) => a.startsWith('--model='));
if (modelArg) { /* allow override, kept simple */ }

try {
  await mkdir(OUT, { recursive: true });
  for (const f of FILES) await dl(f);
  console.log('\nModel ready in vendor/models/' + MODEL);
} catch (e) {
  console.error('\nModel download failed:', e.message);
  console.error('You can retry setup, or the extension will fall back to DOM math + 8K export.');
  process.exit(1);
}
