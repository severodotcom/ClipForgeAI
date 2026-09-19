import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { UsageType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, rateLimitKey, RATE_LIMIT_RULES } from "@/lib/rate-limit";
import { checkQuota, getPeriodStart, getUsageThisPeriod, lockUserForQuota } from "@/lib/usage";
import { retryVideo } from "@/lib/retry";
import { peekCache, runAnalysis, type TranscriptInput } from "@/lib/analysis";

/**
 * Testes de integração do rate limit (P2a) contra a lógica de negócio real
 * de 3 rotas representativas: upload, suggestions e retry de vídeo. Cada
 * "réplica" abaixo reproduz, campo a campo, o trecho do respectivo
 * route.ts a partir do ponto em que o rate limit foi inserido (logo após a
 * sessão, antes de ownership/query/quota/transação/processamento) — mesmo
 * motivo já documentado em usage.test.ts/ai-analysis-quota.test.ts para
 * não importar o módulo da rota diretamente: ele usa `headers()` de
 * `next/headers`, que só funciona dentro do runtime real de uma request do
 * Next.js.
 *
 * O que checkRateLimit em si faz (janela, prune, headers) já está coberto
 * isoladamente em lib/rate-limit.test.ts. Aqui o foco é a ORDEM real:
 * confirmar que a requisição que excede o limite é interceptada ANTES de
 * qualquer efeito de negócio (quota, transação, retry de fato acontecer).
 */

class QuotaExceededTestError extends Error {
  constructor(public readonly quota: Awaited<ReturnType<typeof checkQuota>>) {
    super("QUOTA_EXCEEDED");
  }
}

describe("rate limit integrado nas rotas (P2a)", () => {
  const runId = randomUUID();

  describe("upload de vídeo (POST /api/projects/[id]/videos)", () => {
    let userId: string;
    let projectId: string;

    beforeAll(async () => {
      const user = await prisma.user.create({
        data: { email: `ratelimit-upload-${runId}@clipforge.test`, name: "Rate Limit Upload" },
      });
      userId = user.id;

      const project = await prisma.project.create({
        data: { userId, name: "Projeto rate limit upload" },
      });
      projectId = project.id;

      // Esgota a quota de VIDEO_UPLOAD (free = 3/mês) ANTES de qualquer
      // chamada. Isso é deliberado, não incidental: o que este teste prova
      // é a ORDEM de execução. Com a quota já estourada desde o início,
      // uma rota que checasse quota antes do rate limit responderia 403 em
      // TODAS as chamadas, e nunca veríamos um 429 — não importa quantas
      // vezes chamássemos. Ver 10 respostas 403 seguidas de uma 11ª
      // resposta 429 só é possível se o rate limit for avaliado primeiro,
      // de forma independente do resultado da quota.
      await prisma.usageRecord.createMany({
        data: Array.from({ length: 3 }, () => ({
          userId,
          type: UsageType.VIDEO_UPLOAD,
          amount: 1,
          periodStart: getPeriodStart(),
          idempotencyKey: `TEST_SEED:VIDEO_UPLOAD:${randomUUID()}`,
        })),
      });
    });

    afterAll(async () => {
      await prisma.user.delete({ where: { id: userId } });
    });

    /**
     * Réplica de app/api/projects/[id]/videos/route.ts (POST) do rate
     * limit até a decisão de quota. Não inclui saveVideoFile/ffprobe: a
     * quota já barra antes de esse trecho ser alcançado neste cenário, de
     * propósito, para manter o teste rápido e sem I/O de arquivo real.
     */
    async function replicaUploadFlow() {
      const rateDecision = checkRateLimit(rateLimitKey("upload", userId), RATE_LIMIT_RULES.VIDEO_UPLOAD);

      if (!rateDecision.allowed) {
        return { status: 429 as const, rateDecision };
      }

      try {
        await prisma.$transaction(async (tx) => {
          await lockUserForQuota(userId, tx);

          const quota = await checkQuota(userId, UsageType.VIDEO_UPLOAD, 1, tx);

          if (!quota.allowed) {
            throw new QuotaExceededTestError(quota);
          }

          return tx.video.create({
            data: { projectId, originalFilename: "x.mp4", status: "UPLOADING" },
          });
        });

        return { status: 201 as const };
      } catch (error) {
        if (error instanceof QuotaExceededTestError) {
          return { status: 403 as const };
        }
        throw error;
      }
    }

    it("10 chamadas alcançam a checagem de quota (403); a 11ª é bloqueada pelo rate limit (429) antes disso", async () => {
      const results = [];
      for (let i = 0; i < 11; i++) {
        results.push(await replicaUploadFlow());
      }

      expect(results.slice(0, 10).every((r) => r.status === 403)).toBe(true);

      const eleventh = results[10];
      expect(eleventh.status).toBe(429);
      if (eleventh.status === 429) {
        expect(eleventh.rateDecision.limit).toBe(RATE_LIMIT_RULES.VIDEO_UPLOAD.max);
        expect(eleventh.rateDecision.remaining).toBe(0);
        expect(eleventh.rateDecision.retryAfterSeconds).toBeGreaterThan(0);
      }

      // Nenhum Video foi criado em nenhuma das 11 chamadas (todas caíram
      // em quota ou em rate limit antes da criação).
      const videoCount = await prisma.video.count({ where: { projectId } });
      expect(videoCount).toBe(0);
    });
  });

  describe("suggestions (POST .../suggestions)", () => {
    let userId: string;
    let transcript: TranscriptInput;

    beforeAll(async () => {
      // Força o provider mock independentemente do que estiver em .env
      // (neste projeto, CLIP_ANALYZER_PROVIDER=openai em dev) — este teste
      // é sobre o rate limit da rota, não sobre a integração com a OpenAI
      // (já coberta em lib/ai-analysis-quota.test.ts e
      // lib/analysis/openai-analyzer.test.ts). O mock não chama rede nem
      // consome AI_ANALYSIS quota, então as 10 primeiras chamadas devem
      // todas ter sucesso.
      vi.stubEnv("CLIP_ANALYZER_PROVIDER", "mock");

      const user = await prisma.user.create({
        data: { email: `ratelimit-suggestions-${runId}@clipforge.test`, name: "Rate Limit Suggestions" },
      });
      userId = user.id;

      const project = await prisma.project.create({
        data: { userId, name: "Projeto rate limit suggestions" },
      });

      const video = await prisma.video.create({
        data: { projectId: project.id, originalFilename: "sug.mp4", status: "UPLOADED", duration: 50 },
      });

      await prisma.transcription.create({
        data: {
          videoId: video.id,
          text: "Olá pessoal, hoje vamos falar de um assunto importante e no final tem uma revelação surpreendente.",
          segments: [
            { start: 0, end: 5, text: "Olá pessoal, hoje vamos falar de um assunto importante" },
            { start: 5, end: 10, text: "e no final tem uma revelação surpreendente" },
          ],
        },
      });

      transcript = {
        videoId: video.id,
        duration: 50,
        text: "Olá pessoal, hoje vamos falar de um assunto importante e no final tem uma revelação surpreendente.",
        segments: [
          { start: 0, end: 5, text: "Olá pessoal, hoje vamos falar de um assunto importante" },
          { start: 5, end: 10, text: "e no final tem uma revelação surpreendente" },
        ],
      };
    });

    afterAll(async () => {
      vi.unstubAllEnvs();
      await prisma.user.delete({ where: { id: userId } });
    });

    /**
     * Réplica de .../suggestions/route.ts (POST) do rate limit até
     * runAnalysis, a partir do momento em que a transcrição já foi
     * carregada (mesmo ponto de partida de runSuggestionsFlow em
     * lib/ai-analysis-quota.test.ts).
     */
    async function replicaSuggestionsFlow() {
      const rateDecision = checkRateLimit(
        rateLimitKey("ai-suggestions", userId),
        RATE_LIMIT_RULES.AI_SUGGESTIONS
      );

      if (!rateDecision.allowed) {
        return { status: 429 as const, rateDecision };
      }

      const cachePeek = await peekCache(transcript);

      if (cachePeek.cacheHit) {
        return { status: 200 as const };
      }

      if (cachePeek.requiresQuotaCheck) {
        const quota = await checkQuota(userId, UsageType.AI_ANALYSIS, 1);
        if (!quota.allowed) {
          return { status: 403 as const };
        }
      }

      await runAnalysis(transcript);
      return { status: 200 as const };
    }

    it("10 chamadas têm sucesso (200); a 11ª é bloqueada pelo rate limit (429) antes de chegar em runAnalysis", async () => {
      const results = [];
      for (let i = 0; i < 11; i++) {
        results.push(await replicaSuggestionsFlow());
      }

      expect(results.slice(0, 10).every((r) => r.status === 200)).toBe(true);

      const eleventh = results[10];
      expect(eleventh.status).toBe(429);
      if (eleventh.status === 429) {
        expect(eleventh.rateDecision.remaining).toBe(0);
      }

      // provider mock nunca consome AI_ANALYSIS quota — confirma que as 10
      // chamadas bem-sucedidas realmente passaram pelo caminho do mock, não
      // por acaso por algum outro motivo.
      const usage = await getUsageThisPeriod(userId);
      expect(usage.aiAnalyses).toBe(0);
    });
  });

  describe("retry de vídeo (POST .../videos/[videoId]/retry)", () => {
    let userId: string;
    let projectId: string;
    let videoId: string;
    let retryVideoCalls = 0;

    beforeAll(async () => {
      const user = await prisma.user.create({
        data: { email: `ratelimit-video-retry-${runId}@clipforge.test`, name: "Rate Limit Video Retry" },
      });
      userId = user.id;

      const project = await prisma.project.create({
        data: { userId, name: "Projeto rate limit retry" },
      });
      projectId = project.id;

      // Status proposital diferente de FAILED: retryVideo real sempre
      // retorna "not_failed" sem escrever nada no banco. O ponto deste
      // teste não é o comportamento de retryVideo em si (já coberto
      // exaustivamente em lib/retry.test.ts) — é provar que, mesmo com
      // retryVideo sendo barato e sempre "permitido" de ser chamado do
      // ponto de vista de negócio, a 6ª chamada nem chega a invocá-lo.
      const video = await prisma.video.create({
        data: { projectId, originalFilename: "retry.mp4", status: "UPLOADED", duration: 60 },
      });
      videoId = video.id;
    });

    afterAll(async () => {
      await prisma.user.delete({ where: { id: userId } });
    });

    /** Réplica de .../retry/route.ts (POST, retry de vídeo). */
    async function replicaVideoRetryFlow() {
      const rateDecision = checkRateLimit(rateLimitKey("video-retry", userId), RATE_LIMIT_RULES.VIDEO_RETRY);

      if (!rateDecision.allowed) {
        return { status: 429 as const, rateDecision };
      }

      retryVideoCalls += 1;
      const result = await retryVideo(projectId, videoId, userId);
      return { status: 200 as const, result };
    }

    it("5 chamadas alcançam retryVideo; a 6ª é bloqueada pelo rate limit antes de retryVideo ser chamado", async () => {
      const results = [];
      for (let i = 0; i < 6; i++) {
        results.push(await replicaVideoRetryFlow());
      }

      // A prova central: retryVideo (a função que dispararia uma
      // transcrição real, caso o vídeo estivesse FAILED) só foi invocada 5
      // vezes, nunca 6 — a rajada real de processamento é impedida antes
      // de chegar lá, não apenas contabilizada depois.
      expect(retryVideoCalls).toBe(5);

      expect(results.slice(0, 5).every((r) => r.status === 200)).toBe(true);
      results.slice(0, 5).forEach((r) => {
        if (r.status === 200) {
          expect(r.result.outcome).toBe("not_failed");
        }
      });

      const sixth = results[5];
      expect(sixth.status).toBe(429);
      if (sixth.status === 429) {
        expect(sixth.rateDecision.limit).toBe(RATE_LIMIT_RULES.VIDEO_RETRY.max);
        expect(sixth.rateDecision.remaining).toBe(0);
      }
    });
  });
});
