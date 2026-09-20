import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { dedupeInFlight } from "@/lib/analysis/inflight";

// Cada teste usa uma chave aleatória própria — o Map interno é um
// singleton global (mesmo truque de lib/concurrency.ts/lib/rate-limit.ts),
// então isolar por chave evita qualquer interferência entre testes sem
// precisar expor um hook de reset.
function uniqueKey(label: string) {
  return `${label}:${randomUUID()}`;
}

/** Resolve/rejeita manualmente, para controlar com precisão quando `run()`
 * termina em relação às chamadas concorrentes de dedupeInFlight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("dedupeInFlight (lib/analysis/inflight.ts)", () => {
  it("chamadas concorrentes com a mesma chave compartilham a mesma Promise", async () => {
    const key = uniqueKey("compartilha-promise");
    const { promise, resolve } = deferred<string>();
    const run = vi.fn(() => promise);

    const a = dedupeInFlight(key, run);
    const b = dedupeInFlight(key, run);

    expect(a).toBe(b); // é literalmente o mesmo objeto Promise

    resolve("resultado-compartilhado");

    await expect(a).resolves.toBe("resultado-compartilhado");
    await expect(b).resolves.toBe("resultado-compartilhado");
  });

  it("run() é chamado exatamente uma vez mesmo com várias chamadas concorrentes", async () => {
    const key = uniqueKey("run-uma-vez");
    const { promise, resolve } = deferred<number>();
    const run = vi.fn(() => promise);

    const results = [
      dedupeInFlight(key, run),
      dedupeInFlight(key, run),
      dedupeInFlight(key, run),
    ];

    expect(run).toHaveBeenCalledTimes(1);

    resolve(42);
    await Promise.all(results);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("chaves diferentes não compartilham Promise e cada uma chama run() de forma independente", async () => {
    const keyA = uniqueKey("chave-a");
    const keyB = uniqueKey("chave-b");
    const runA = vi.fn(async () => "valor-a");
    const runB = vi.fn(async () => "valor-b");

    const [resultA, resultB] = await Promise.all([
      dedupeInFlight(keyA, runA),
      dedupeInFlight(keyB, runB),
    ]);

    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
    expect(resultA).toBe("valor-a");
    expect(resultB).toBe("valor-b");
  });

  it("depois que a Promise resolve, uma nova chamada com a mesma chave executa run() de novo", async () => {
    const key = uniqueKey("executa-de-novo-apos-sucesso");
    const run = vi.fn(async () => "primeira");

    const first = await dedupeInFlight(key, run);
    expect(first).toBe("primeira");
    expect(run).toHaveBeenCalledTimes(1);

    run.mockResolvedValueOnce("segunda");
    const second = await dedupeInFlight(key, run);

    expect(second).toBe("segunda");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("em caso de rejeição, todos os chamadores concorrentes recebem o mesmo erro", async () => {
    const key = uniqueKey("erro-compartilhado");
    const { promise, reject } = deferred<never>();
    const run = vi.fn(() => promise);
    const error = new Error("falha simulada na chamada real");

    const a = dedupeInFlight(key, run);
    const b = dedupeInFlight(key, run);

    reject(error);

    await expect(a).rejects.toBe(error);
    await expect(b).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("depois de uma rejeição, uma nova chamada com a mesma chave pode executar run() de novo", async () => {
    const key = uniqueKey("tenta-de-novo-apos-erro");
    const run = vi.fn().mockRejectedValueOnce(new Error("primeira falha"));

    await expect(dedupeInFlight(key, run)).rejects.toThrow("primeira falha");
    expect(run).toHaveBeenCalledTimes(1);

    run.mockResolvedValueOnce("recuperou");
    await expect(dedupeInFlight(key, run)).resolves.toBe("recuperou");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a entrada é removida do Map mesmo quando run() falha (sem lock preso)", async () => {
    const key = uniqueKey("limpeza-apos-falha");
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("falha 1"))
      .mockRejectedValueOnce(new Error("falha 2"));

    await expect(dedupeInFlight(key, run)).rejects.toThrow("falha 1");
    await expect(dedupeInFlight(key, run)).rejects.toThrow("falha 2");

    // Se a entrada tivesse ficado presa após a 1ª falha, a 2ª chamada
    // reaproveitaria a mesma Promise rejeitada (mesmo erro "falha 1") em
    // vez de invocar run() de novo — as duas mensagens de erro distintas
    // acima já provam que não foi isso que aconteceu, e o contador abaixo
    // confirma.
    expect(run).toHaveBeenCalledTimes(2);
  });
});
