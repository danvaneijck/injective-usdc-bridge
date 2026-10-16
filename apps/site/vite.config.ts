import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const pkg = (p: string) => fileURLToPath(new URL(`../../packages/bridge/src/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Build the widget from source: no package build step between edits.
    alias: [
      { find: /^injective-usdc-bridge\/react\/styles\.css$/, replacement: pkg("react/styles.css") },
      { find: /^injective-usdc-bridge\/react$/, replacement: pkg("react/index.ts") },
      { find: /^injective-usdc-bridge$/, replacement: pkg("index.ts") },
    ],
  },
  server: {
    // The built site is served by the bridge service itself, so it calls its
    // own origin; in dev, send those calls to the live API.
    proxy: { "/v1": { target: process.env.BRIDGE_API ?? "https://bridge-api.choice.exchange", changeOrigin: true } },
  },
  build: { sourcemap: true },
});
