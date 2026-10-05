// Serve the built playground locally, the way GitHub Pages will: static files,
// nothing else. Build it first (node packages/resin/scripts/build.mjs playground).
//   node packages/resin/scripts/serve-playground.mjs [port]
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/playground");
const port = Number(process.argv[2]) || 4330;
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };

if (!existsSync(join(dir, "index.html"))) {
  console.error("No playground build: run node packages/resin/scripts/build.mjs playground");
  process.exit(1);
}
http
  .createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const file = normalize(join(dir, p));
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`AlphaResin playground on http://localhost:${port}`));
