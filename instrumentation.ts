// Roda uma única vez quando uma nova instância do servidor Next.js sobe,
// antes de aceitar qualquer request (contrato do Next.js — ver
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md,
// estável desde a v15; este projeto está na v16.3.0). O Next chama
// `register()` em todo runtime (node e edge); o reconciliador usa Prisma,
// então só roda no runtime node.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { reconcileStuckOperations } = await import("@/lib/reconciliation");

  try {
    await reconcileStuckOperations();
  } catch (error) {
    // Best-effort: uma falha aqui (ex: banco ainda não acessível no exato
    // momento do boot) não deve impedir o servidor de subir — na pior das
    // hipóteses, as linhas presas ficam para a próxima reinicialização
    // reconciliar.
    console.error(
      "[reconciliation] Falha ao reconciliar operações presas na inicialização:",
      error
    );
  }
}
