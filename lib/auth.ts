import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@/lib/prisma";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  emailAndPassword: {
    enabled: true,
  },

  // P2a: rate limiting nativo do better-auth, tornado explícito. Por
  // padrão (`enabled: options.rateLimit?.enabled ?? isProduction`, ver
  // node_modules/better-auth/dist/context/create-context.mjs) ele já liga
  // sozinho quando NODE_ENV=production — que é o caso do Dockerfile — mas
  // deixamos isso explícito para não depender de um efeito implícito.
  // Não sobrescrevemos window/max (default 100 req/10s por IP+path) nem as
  // regras especiais já embutidas para /sign-in, /sign-up,
  // /change-password, /change-email (3 req/10s) e
  // /forget-password|/request-password-reset|/send-verification-email
  // (3 req/60s) — cobrem brute force de login e spam de registro como
  // aprovado, sem precisar de um limitador próprio para autenticação.
  rateLimit: {
    enabled: true,
  },

  // Resolução de IP atrás do proxy do Render: o Render é o único hop entre
  // o cliente e este processo e escreve X-Forwarded-For com o IP real do
  // cliente como valor único (sem encadear proxies anteriores) — é
  // exatamente o caso em que o resolvedor de IP do better-auth confia no
  // header sem precisar de `trustedProxies` (ver
  // node_modules/@better-auth/core/dist/utils/ip.mjs: um header com um só
  // valor é aceito sem lista de proxies confiáveis declarada; com vários
  // valores e sem `trustedProxies`, o IP é descartado e a requisição cai
  // no bucket compartilhado "no-trusted-ip"). `trustedProxies` fica de
  // fora de propósito: não temos o CIDR real da borda do Render para
  // declarar aqui com segurança, e declarar um errado pioraria a
  // resolução em vez de ajudar. Se um CDN/proxy adicional for colocado na
  // frente do Render no futuro, isto precisa ser revisitado.
  advanced: {
    ipAddress: {
      ipAddressHeaders: ["x-forwarded-for"],
    },
  },
});
