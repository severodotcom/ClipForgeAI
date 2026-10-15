import type { NextConfig } from "next";

// CSP estática das rotas de API. As páginas recebem uma CSP com nonce por
// request em proxy.ts (ver lib/csp.ts); as duas não podem se sobrepor, pois o
// navegador aplicaria ambas e a estática bloquearia os scripts com nonce.
const apiContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // Standalone server output for the production Docker image — copies only
  // the traced files (+ a minimal node_modules) into .next/standalone.
  output: "standalone",

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=()",
          },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Content-Security-Policy", value: apiContentSecurityPolicy },
        ],
      },
    ];
  },

  // @huggingface/transformers, onnxruntime-node and sharp ship native
  // binaries and, in the case of transformers, a runtime-populated file
  // cache (the downloaded Whisper model) that Next's static tracing can't
  // discover via require()/import analysis alone. Without this, `next
  // build` would silently drop those files from .next/standalone and the
  // container would fail to load the model or the native ONNX binding.
  outputFileTracingIncludes: {
    "/*": [
      "node_modules/@huggingface/transformers/**/*",
      "node_modules/onnxruntime-node/**/*",
      "node_modules/sharp/**/*",
      "node_modules/@img/**/*",
    ],
  },
};

export default nextConfig;
