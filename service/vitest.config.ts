import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "injective-usdc-bridge": fileURLToPath(new URL("../packages/bridge/src/index.ts", import.meta.url)),
    },
  },
});
