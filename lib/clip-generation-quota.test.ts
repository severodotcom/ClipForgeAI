import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsageType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  checkQuota,
  getPeriodStart,
  getUsageThisPeriod,
  lockUserForQuota,
  recordUsage,
} from "./usage";

class QuotaExceededTestError extends Error {
  constructor(public readonly quota: Awaited<ReturnType<typeof checkQuota>>) {
    super("QUOTA_EXCEEDED");
  }
}

/**
 * Réplica, campo a campo, da transação de reserva em
 * app/api/projects/[id]/videos/[videoId]/clips/route.ts (POST): lock ->
 * checkQuota -> tx.clip.create -> recordUsage, com
 * idempotencyKey: `CLIP_GENERATED:${clip.id}`. Não importamos o módulo da
 * rota diretamente pelo mesmo motivo documentado em usage.test.ts: ele usa
 * `headers()` de `next/headers`, que só funciona dentro do runtime real de
 * uma request do Next.js.
 */
async function reserveClipGeneration(
  userId: string,
  videoId: string,
  startTime: number,
  endTime: number
) {
  return prisma.$transaction(async (tx) => {
    await lockUserForQuota(userId, tx);

    const quota = await checkQuota(userId, UsageType.CLIP_GENERATED, 1, tx);

    if (!quota.allowed) {
      throw new QuotaExceededTestError(quota);
    }

    const clip = await tx.clip.create({
      data: { videoId, startTime, endTime, status: "PENDING" },
    });

    await recordUsage(
      {
        userId,
        type: UsageType.CLIP_GENERATED,
        amount: 1,
        periodStart: getPeriodStart(),
        idempotencyKey: `CLIP_GENERATED:${clip.id}`,
        videoId,
        clipId: clip.id,
      },
      tx
    );

    return clip;
  });
}

describe("reserva de quota CLIP_GENERATED (mesma lógica usada pela rota de criação de clipes)", () => {
  const runId = randomUUID();
  let userId: string;
  let videoId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `usage-clip-test-${runId}@clipforge.test`, name: "Usage Clip Test User" },
    });
    userId = user.id;

    const project = await prisma.project.create({
      data: { userId, name: "Projeto de teste de clipes" },
    });

    const video = await prisma.video.create({
      data: {
        projectId: project.id,
        originalFilename: "video-fixture.mp4",
        status: "UPLOADED",
        duration: 600,
      },
    });
    videoId = video.id;
  });

  afterAll(async () => {
    // Clip -> Video -> Project -> User e UsageRecord -> User têm
    // onDelete: Cascade (UsageRecord.videoId/clipId NÃO têm cascade — são
    // referências de ledger, de propósito — mas UsageRecord.userId tem, e
    // é isso que limpa tudo aqui).
    await prisma.user.delete({ where: { id: userId } });
  });

  it("usuário free com 0 clipes: criação é permitida", async () => {
    const clip = await reserveClipGeneration(userId, videoId, 0, 10);

    expect(clip.status).toBe("PENDING");

    const usage = await getUsageThisPeriod(userId);
    expect(usage.clips).toBe(1);
  });

  it("usuário free com 19 clipes: 20º é permitido (limite free = 20)", async () => {
    // já tem 1 do teste anterior; sobe até 19 antes de testar o 20º.
    for (let i = 0; i < 18; i++) {
      await reserveClipGeneration(userId, videoId, 0, 10);
    }

    const usageBefore = await getUsageThisPeriod(userId);
    expect(usageBefore.clips).toBe(19);

    const clip = await reserveClipGeneration(userId, videoId, 0, 10);
    expect(clip.status).toBe("PENDING");

    const usageAfter = await getUsageThisPeriod(userId);
    expect(usageAfter.clips).toBe(20);
  });

  it("usuário free com 20 clipes: próxima criação é rejeitada", async () => {
    await expect(reserveClipGeneration(userId, videoId, 0, 10)).rejects.toThrow(
      "QUOTA_EXCEEDED"
    );
  });

  it("criação rejeitada não cria Clip nem UsageRecord novos", async () => {
    const clipsBefore = await prisma.clip.count({ where: { videoId } });
    const usageRecordsBefore = await prisma.usageRecord.count({
      where: { userId, type: UsageType.CLIP_GENERATED },
    });

    await expect(reserveClipGeneration(userId, videoId, 20, 30)).rejects.toThrow(
      "QUOTA_EXCEEDED"
    );

    const clipsAfter = await prisma.clip.count({ where: { videoId } });
    const usageRecordsAfter = await prisma.usageRecord.count({
      where: { userId, type: UsageType.CLIP_GENERATED },
    });

    expect(clipsAfter).toBe(clipsBefore);
    expect(usageRecordsAfter).toBe(usageRecordsBefore);
  });

  it("criação bem-sucedida cria exatamente 1 UsageRecord com videoId/clipId/idempotencyKey corretos", async () => {
    const soloUser = await prisma.user.create({
      data: { email: `usage-clip-solo-${runId}@clipforge.test`, name: "Solo" },
    });
    const soloProject = await prisma.project.create({
      data: { userId: soloUser.id, name: "Projeto solo" },
    });
    const soloVideo = await prisma.video.create({
      data: { projectId: soloProject.id, originalFilename: "solo.mp4", status: "UPLOADED", duration: 60 },
    });

    try {
      const clip = await reserveClipGeneration(soloUser.id, soloVideo.id, 0, 10);

      const records = await prisma.usageRecord.findMany({
        where: { userId: soloUser.id, type: UsageType.CLIP_GENERATED },
      });

      expect(records).toHaveLength(1);
      expect(records[0].videoId).toBe(soloVideo.id);
      expect(records[0].clipId).toBe(clip.id);
      expect(records[0].idempotencyKey).toBe(`CLIP_GENERATED:${clip.id}`);
    } finally {
      await prisma.user.delete({ where: { id: soloUser.id } });
    }
  });

  it("repetir recordUsage para o mesmo clipe não duplica o UsageRecord", async () => {
    const soloUser = await prisma.user.create({
      data: { email: `usage-clip-retry-${runId}@clipforge.test`, name: "Retry" },
    });
    const soloProject = await prisma.project.create({
      data: { userId: soloUser.id, name: "Projeto retry" },
    });
    const soloVideo = await prisma.video.create({
      data: { projectId: soloProject.id, originalFilename: "retry.mp4", status: "UPLOADED", duration: 60 },
    });

    try {
      const clip = await reserveClipGeneration(soloUser.id, soloVideo.id, 0, 10);
      const idempotencyKey = `CLIP_GENERATED:${clip.id}`;

      // Simula um retry da mesma requisição de criação chamando recordUsage
      // de novo, fora de transação, com a mesma chave.
      await recordUsage({
        userId: soloUser.id,
        type: UsageType.CLIP_GENERATED,
        amount: 1,
        periodStart: getPeriodStart(),
        idempotencyKey,
        videoId: soloVideo.id,
        clipId: clip.id,
      });
      await recordUsage({
        userId: soloUser.id,
        type: UsageType.CLIP_GENERATED,
        amount: 1,
        periodStart: getPeriodStart(),
        idempotencyKey,
        videoId: soloVideo.id,
        clipId: clip.id,
      });

      const records = await prisma.usageRecord.findMany({ where: { idempotencyKey } });
      expect(records).toHaveLength(1);
    } finally {
      await prisma.user.delete({ where: { id: soloUser.id } });
    }
  });

  it(
    "regeneração (edição) do mesmo clipe é gratuita: idempotencyKey baseada só no clipId impede nova cobrança",
    async () => {
      // A rota PATCH (regeneração) hoje nunca chama recordUsage — esta
      // suíte confirma o motivo estrutural pelo qual isso é seguro mesmo se
      // algum caminho futuro tentasse cobrar de novo: a idempotencyKey é
      // `CLIP_GENERATED:<clipId>` (sem número de tentativa/versão, por
      // decisão de produto confirmada), então uma segunda chamada de
      // recordUsage para o MESMO clipId — simulando uma regeneração que
      // tentasse cobrar — é um no-op no ledger, e usage.clips não sobe.
      const soloUser = await prisma.user.create({
        data: { email: `usage-clip-regen-${runId}@clipforge.test`, name: "Regen" },
      });
      const soloProject = await prisma.project.create({
        data: { userId: soloUser.id, name: "Projeto regen" },
      });
      const soloVideo = await prisma.video.create({
        data: { projectId: soloProject.id, originalFilename: "regen.mp4", status: "UPLOADED", duration: 60 },
      });

      try {
        const clip = await reserveClipGeneration(soloUser.id, soloVideo.id, 0, 10);

        const usageAfterCreate = await getUsageThisPeriod(soloUser.id);
        expect(usageAfterCreate.clips).toBe(1);

        // Simula uma "regeneração" (edição de startTime/endTime seguida de
        // nova geração) tentando registrar uso de novo para o mesmo clipId.
        await recordUsage({
          userId: soloUser.id,
          type: UsageType.CLIP_GENERATED,
          amount: 1,
          periodStart: getPeriodStart(),
          idempotencyKey: `CLIP_GENERATED:${clip.id}`,
          videoId: soloVideo.id,
          clipId: clip.id,
        });

        const usageAfterRegen = await getUsageThisPeriod(soloUser.id);
        expect(usageAfterRegen.clips).toBe(1); // não subiu

        const records = await prisma.usageRecord.findMany({
          where: { userId: soloUser.id, type: UsageType.CLIP_GENERATED },
        });
        expect(records).toHaveLength(1);
      } finally {
        await prisma.user.delete({ where: { id: soloUser.id } });
      }
    }
  );

  it("duas criações concorrentes não ultrapassam a quota (lock via SELECT ... FOR UPDATE)", async () => {
    const concurrentUser = await prisma.user.create({
      data: { email: `usage-clip-concurrent-${runId}@clipforge.test`, name: "Concurrent" },
    });
    const concurrentProject = await prisma.project.create({
      data: { userId: concurrentUser.id, name: "Projeto concorrência clipes" },
    });
    const concurrentVideo = await prisma.video.create({
      data: {
        projectId: concurrentProject.id,
        originalFilename: "concurrent.mp4",
        status: "UPLOADED",
        duration: 600,
      },
    });

    try {
      // Deixa o usuário com 19/20 clipes usados, sequencialmente.
      for (let i = 0; i < 19; i++) {
        await reserveClipGeneration(concurrentUser.id, concurrentVideo.id, 0, 10);
      }

      const usageBefore = await getUsageThisPeriod(concurrentUser.id);
      expect(usageBefore.clips).toBe(19);

      // Duas requisições disputando a última vaga (limite = 20) ao mesmo tempo.
      const results = await Promise.allSettled([
        reserveClipGeneration(concurrentUser.id, concurrentVideo.id, 0, 10),
        reserveClipGeneration(concurrentUser.id, concurrentVideo.id, 10, 20),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      if (rejected[0]?.status === "rejected") {
        expect((rejected[0].reason as Error).message).toBe("QUOTA_EXCEEDED");
      }

      const finalClipCount = await prisma.clip.count({ where: { videoId: concurrentVideo.id } });
      const finalUsage = await getUsageThisPeriod(concurrentUser.id);

      expect(finalClipCount).toBe(20);
      expect(finalUsage.clips).toBe(20);
    } finally {
      await prisma.user.delete({ where: { id: concurrentUser.id } });
    }
  });
});
