import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Hono } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The page may talk to any https endpoint (Circle's API, every chain's RPC)
 * and nothing may frame it: a bridge inside someone else's iframe is a
 * clickjacking target. Wallet extensions inject outside CSP's reach. The one
 * outside script is Cloudflare's analytics beacon, which its edge injects into
 * every page of the zone; it already sits in front of the site.
 */
export const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self' https: wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Serves the built site (apps/site) beside the API. Unknown paths get
 * index.html, so /tx/<domain>/<hash> links work; /v1 stays the API's.
 */
export function serveSite(app: Hono, dir: string): void {
  const root = resolve(dir);
  app.get("*", async (c) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname);
    if (path.startsWith("/v1/") || path === "/v1") return c.json({ error: "not found" }, 404);
    const candidate = normalize(join(root, path));
    let file = candidate.startsWith(root + sep) ? candidate : join(root, "index.html");
    let body = await readFile(file).catch(() => null);
    if (!body) {
      file = join(root, "index.html");
      body = await readFile(file).catch(() => null);
      if (!body) return c.text("site not built", 404);
    }
    const hashed = path.startsWith("/assets/");
    return c.body(new Uint8Array(body), 200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      ...(extname(file) === ".html" ? { "content-security-policy": SITE_CSP } : {}),
    });
  });
}
