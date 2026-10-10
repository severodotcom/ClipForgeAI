import type { NextConfig } from "next";

const contentSecurityPolicy = [
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
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
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
