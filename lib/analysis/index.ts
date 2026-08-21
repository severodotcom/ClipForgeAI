import type { ClipAnalyzer, ClipSuggestion, TranscriptInput } from "./types";
import { mockAnalyzer } from "./mock-analyzer";
import { openAiAnalyzer } from "./openai-analyzer";
import { sanitizeSuggestions, sanitizeTranscript } from "./sanitize";

const DEFAULT_ANALYZER = "mock";

const ANALYZERS: Record<string, ClipAnalyzer> = {
  mock: mockAnalyzer,
  openai: openAiAnalyzer,
};

export function getClipAnalyzer(): ClipAnalyzer {
  const key = process.env.CLIP_ANALYZER_PROVIDER ?? DEFAULT_ANALYZER;
  const analyzer = ANALYZERS[key];

  if (!analyzer) {
    throw new Error(
      `Analisador de clipes desconhecido: "${key}". Disponíveis: ${Object.keys(ANALYZERS).join(", ")}`
    );
  }

  return analyzer;
}

/**
 * Single entry point callers should use instead of calling a ClipAnalyzer
 * directly: sanitizes the transcript going in and validates/repairs the
 * suggestions coming out (score range, degenerate/out-of-bounds time
 * ranges, empty title/reason, excessive overlap between candidates). This
 * safety net applies to every provider uniformly, so a future real
 * (e.g. LLM-backed) analyzer only needs to implement ClipAnalyzer.analyze
 * and propose candidates — it doesn't need to reimplement validation.
 */
export async function analyzeTranscript(
  transcript: TranscriptInput
): Promise<{ analyzer: string; suggestions: ClipSuggestion[] }> {
  const analyzer = getClipAnalyzer();
  const sanitizedTranscript = sanitizeTranscript(transcript);
  const rawSuggestions = await analyzer.analyze(sanitizedTranscript);
  const suggestions = sanitizeSuggestions(rawSuggestions, sanitizedTranscript);

  return { analyzer: analyzer.name, suggestions };
}

export type { ClipAnalyzer, ClipSuggestion, TranscriptInput, TranscriptSegment } from "./types";
