// After `npm run build`: walks everything dist/index.js (and .cjs) loads and
// fails if the core reaches any package outside its own dependencies. The
// core must never load viem or React; those belong to /viem and /react.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const allowed = /^@noble\/(hashes|curves)\/|^@scure\/base$/;
const specifier = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

let bad = 0;
for (const entry of ["index.js", "index.cjs"]) {
  const seen = new Set();
  const queue = [join(dist, entry)];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(specifier)) {
      if (spec.startsWith(".")) queue.push(join(dirname(file), spec));
      else if (!allowed.test(spec)) {
        console.error(`${entry} loads "${spec}" (via ${file.slice(dist.length + 1)})`);
        bad++;
      }
    }
  }
  console.log(`${entry}: ${seen.size} files checked`);
}
if (bad) process.exit(1);
