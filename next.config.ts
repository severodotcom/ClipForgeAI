import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone server output for the production Docker image — copies only
  // the traced files (+ a minimal node_modules) into .next/standalone.
  output: "standalone",

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
