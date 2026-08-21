import type { AnalysisResult, ClipAnalyzer, ClipSuggestion, TranscriptInput } from "./types";
import { mockAnalyzer } from "./mock-analyzer";
import { analyzeWithUsage, openAiAnalyzer, peekCachedSuggestions } from "./openai-analyzer";
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

function getActiveProviderKey(): string {
  return process.env.CLIP_ANALYZER_PROVIDER ?? DEFAULT_ANALYZER;
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

export type CachePeekResult =
  | { cacheHit: true; result: AnalysisResult }
  | { cacheHit: false; requiresQuotaCheck: boolean };

/**
 * Network-free, cost-free pre-check for AI_ANALYSIS quota enforcement
 * (see suggestions/route.ts). Only the "openai" provider has a cache to
 * hit and a real cost to protect against — any other active provider
 * (e.g. mock) reports `requiresQuotaCheck: false`, meaning the route
 * should skip the quota check entirely and go straight to `runAnalysis`,
 * exactly as it did before AI_ANALYSIS quotas existed. This keeps quota
 * enforcement scoped to the provider that actually costs money, without
 * the route needing to know which provider is active.
 */
export async function peekCache(transcript: TranscriptInput): Promise<CachePeekResult> {
  if (getActiveProviderKey() !== "openai") {
    return { cacheHit: false, requiresQuotaCheck: false };
  }

  const sanitizedTranscript = sanitizeTranscript(transcript);
  const lookup = await peekCachedSuggestions(sanitizedTranscript);

  if (!lookup.hit) {
    return { cacheHit: false, requiresQuotaCheck: true };
  }

  return {
    cacheHit: true,
    result: {
      analyzer: "openai",
      suggestions: sanitizeSuggestions(lookup.suggestions, sanitizedTranscript),
      cacheHit: true,
      usage: null,
      analysisCacheId: lookup.analysisCacheId,
    },
  };
}

/**
 * Runs the actual analysis. For a confirmed cache miss on the "openai"
 * provider, the caller (suggestions/route.ts) is responsible for having
 * already checked AI_ANALYSIS quota when `peekCache` returned
 * `requiresQuotaCheck: true` — this function itself has no concept of
 * users/quota, consistent with the rest of lib/analysis/. For any other
 * provider, this is equivalent to `analyzeTranscript` with the metadata
 * fields filled in as null/false.
 */
export async function runAnalysis(transcript: TranscriptInput): Promise<AnalysisResult> {
  if (getActiveProviderKey() === "openai") {
    const sanitizedTranscript = sanitizeTranscript(transcript);
    const { suggestions, usage, cacheHit, analysisCacheId } = await analyzeWithUsage(sanitizedTranscript);

    return {
      analyzer: "openai",
      suggestions: sanitizeSuggestions(suggestions, sanitizedTranscript),
      cacheHit,
      usage,
      analysisCacheId,
    };
  }

  const { analyzer, suggestions } = await analyzeTranscript(transcript);

  return { analyzer, suggestions, cacheHit: false, usage: null, analysisCacheId: null };
}

export type { AnalysisResult, ClipAnalyzer, ClipSuggestion, TokenUsage, TranscriptInput, TranscriptSegment } from "./types";
