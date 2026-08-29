import { describe, expect, it } from "vitest";
import { Semaphore, whisperSemaphore, clipSemaphore } from "@/lib/concurrency";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Semaphore (lib/concurrency.ts)", () => {
  it("concorrência 1: duas execuções nunca rodam ao mesmo tempo, cada uma espera a anterior terminar", async () => {
    const semaphore = new Semaphore(1);
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    async function task(name: string) {
      return semaphore.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${name}`);
        await delay(30);
        order.push(`end:${name}`);
        active -= 1;
      });
    }

    await Promise.all([task("a"), task("b"), task("c")]);

    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:c",
      "end:c",
    ]);
  });

  it("a criação/execução da operação pesada só começa depois de adquirir o slot, não junto com a chamada a run()", async () => {
    const semaphore = new Semaphore(1);

    const blocker = semaphore.run(async () => {
      await delay(30);
    });

    await delay(5); // 'blocker' já está segurando o único slot

    let secondFnInvoked = false;
    const second = semaphore.run(() => {
      // Só deve ser chamada quando o slot for liberado pelo blocker.
      secondFnInvoked = true;
      return Promise.resolve();
    });

    // Passado bem menos que os 30ms do blocker: a segunda função ainda não
    // deve ter sido sequer invocada (não é só a promise que espera — a
    // criação da execução pesada em si é adiada).
    await delay(5);
    expect(secondFnInvoked).toBe(false);

    await Promise.all([blocker, second]);
    expect(secondFnInvoked).toBe(true);
  });

  it("libera o slot após sucesso — a próxima tarefa roda em seguida, sem ficar presa", async () => {
    const semaphore = new Semaphore(1);

    await semaphore.run(async () => "ok");

    let ran = false;
    await semaphore.run(async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });

  it("libera o slot após erro — não fica travado para a próxima tarefa", async () => {
    const semaphore = new Semaphore(1);

    await expect(
      semaphore.run(async () => {
        throw new Error("falha simulada");
      })
    ).rejects.toThrow("falha simulada");

    let ran = false;
    await semaphore.run(async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });

  it("libera o slot após timeout — não fica travado para a próxima tarefa mesmo com a operação pesada ainda pendurada", async () => {
    const semaphore = new Semaphore(1);

    function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout simulado")), ms);
        promise.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          }
        );
      });
    }

    // Simula uma operação pesada que nunca termina sozinha (equivalente a
    // um Whisper/ffmpeg travado) — só o timeout resolve essa corrida.
    const neverResolves = new Promise(() => {});

    await expect(
      semaphore.run(() => withTimeout(neverResolves, 15))
    ).rejects.toThrow("timeout simulado");

    let ran = false;
    await semaphore.run(async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });
});

describe("semáforos singleton usados nos pontos de integração reais (lib/transcription.ts, lib/clips.ts)", () => {
  it("whisperSemaphore: 3 'transcrições' concorrentes -> apenas uma executa por vez", async () => {
    let active = 0;
    let maxActive = 0;

    async function fakeTranscription() {
      return whisperSemaphore.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
      });
    }

    await Promise.all([fakeTranscription(), fakeTranscription(), fakeTranscription()]);

    expect(maxActive).toBe(1);
  });

  it("clipSemaphore: 3 'gerações de clipe' concorrentes -> apenas uma executa por vez", async () => {
    let active = 0;
    let maxActive = 0;

    async function fakeClipGeneration() {
      return clipSemaphore.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
      });
    }

    await Promise.all([fakeClipGeneration(), fakeClipGeneration(), fakeClipGeneration()]);

    expect(maxActive).toBe(1);
  });

  it("whisperSemaphore e clipSemaphore são independentes — uma transcrição não bloqueia uma geração de clipe simultânea", async () => {
    let whisperActive = 0;
    let clipActive = 0;
    let bothActiveAtOnce = false;

    const whisperTask = whisperSemaphore.run(async () => {
      whisperActive += 1;
      if (clipActive > 0) bothActiveAtOnce = true;
      await delay(30);
      whisperActive -= 1;
    });

    await delay(5);

    const clipTask = clipSemaphore.run(async () => {
      clipActive += 1;
      if (whisperActive > 0) bothActiveAtOnce = true;
      await delay(10);
      clipActive -= 1;
    });

    await Promise.all([whisperTask, clipTask]);

    expect(bothActiveAtOnce).toBe(true);
  });
});
