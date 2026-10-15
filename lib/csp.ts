// Content-Security-Policy das páginas, gerada por request em proxy.ts.
//
// O Next.js entrega o payload RSC em <script> inline (self.__next_f.push),
// então script-src precisa de um nonce por request: o Next lê o
// 'nonce-…' do header Content-Security-Policy do request e o aplica
// automaticamente aos seus scripts. Em desenvolvimento o React precisa de
// 'unsafe-eval' e o HMR injeta <style> inline; nada disso vai para produção.
export function buildContentSecurityPolicy(
  nonce: string,
  isDev: boolean,
): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "media-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}
