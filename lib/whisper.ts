import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

const WHISPER_MODEL = "Xenova/whisper-base";

const globalForWhisper = globalThis as unknown as {
  whisperPipeline: Promise<AutomaticSpeechRecognitionPipeline> | undefined;
};

export function getWhisperPipeline() {
  if (!globalForWhisper.whisperPipeline) {
    globalForWhisper.whisperPipeline = pipeline(
      "automatic-speech-recognition",
      WHISPER_MODEL
    );
  }

  return globalForWhisper.whisperPipeline;
}
