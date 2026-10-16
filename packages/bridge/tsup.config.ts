import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  // tsup's dts worker sets `baseUrl`, which TypeScript 6 flags as deprecated.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
});
