// Downloads and caches the Whisper model weights into
// node_modules/@huggingface/transformers/.cache/ at Docker build time,
// so the production image never needs network access to Hugging Face Hub
// at runtime and cold-start doesn't pay the download cost.
//
// Must run BEFORE `next build`: Next's output file tracing (see
// outputFileTracingIncludes in next.config.ts) copies whatever is already
// on disk under node_modules/@huggingface/transformers/ into
// .next/standalone, so the cache has to be populated first.
//
// Intentionally standalone (no ts-node/tsx dependency) and imports the
// same model id lib/whisper.ts uses, without changing that file.
import { pipeline } from "@huggingface/transformers";

const WHISPER_MODEL = "Xenova/whisper-base";

console.log(`[warm-whisper-model] downloading ${WHISPER_MODEL}...`);

await pipeline("automatic-speech-recognition", WHISPER_MODEL);

console.log("[warm-whisper-model] model cached.");
