import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^injective-usdc-bridge\/viem$/, replacement: fileURLToPath(new URL("../packages/bridge/src/viem.ts", import.meta.url)) },
      { find: /^injective-usdc-bridge$/, replacement: fileURLToPath(new URL("../packages/bridge/src/index.ts", import.meta.url)) },
    ],
  },
});
