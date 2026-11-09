import { defineConfig } from "tsup";

export default defineConfig({
  // The widget and the viem readers are their own entries, so the core never
  // pulls in React or viem (scripts/check-core-imports.mjs checks the build).
  entry: { index: "src/index.ts", viem: "src/viem.ts", "react/index": "src/react/index.ts" },
  format: ["esm", "cjs"],
  // tsup's dts worker sets `baseUrl`, which TypeScript 6 flags as deprecated.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  external: ["react", "react-dom", "react/jsx-runtime", "viem"],
});
