// Liveness check para o Render (Health Check Path) — só confirma que o
// processo Node está vivo e respondendo HTTP. Deliberadamente não consulta
// Postgres/storage/Whisper/OpenAI (ver auditoria de P2c): um readiness que
// dependesse dessas peças faria o Render reiniciar o container por uma
// instabilidade externa em algo que já está saudável.
export async function GET() {
  return Response.json({ status: "ok" });
}
