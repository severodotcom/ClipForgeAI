import "dotenv/config";
import { configDefaults, defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    // .next/standalone contém uma cópia dos arquivos fonte gerada pelo build
    // (ver Dockerfile); sem essa exclusão o Vitest também coleta os testes
    // duplicados de lá, que falham por não terem node_modules resolvidos.
    exclude: [...configDefaults.exclude, "**/.next/**"],
  },
});
