// Registry HTTP server (Task 6) — `createServer(store)` wires routes.ts
// onto node:http. Running standalone (`npm start` / the compose file),
// it starts a store over the documents directory and listens on PORT
// (default 8080). Tests embed the server over a fixture-backed temp dir
// and listen on an ephemeral port (`listen(0)`).

import { createServer as httpCreateServer, type Server } from "node:http";
import { start, type RegistryStore } from "./store.js";
import { route } from "./routes.js";

export { API_PREFIX, CLAIMS_UNIMPLEMENTED, OVERLAY_UNIMPLEMENTED } from "./routes.js";

/** The registry's HTTP surface over an already-started store. */
export function createServer(store: RegistryStore): Server {
  return httpCreateServer((req, res) => {
    try {
      route(store, req, res);
    } catch (err) {
      // route() is written never to throw; this is a last-resort guard so
      // a bug can't take the process down (single-replica availability).
      const payload = JSON.stringify({ error: `internal error: ${String(err)}` });
      res.writeHead(500, { "content-type": "application/json" });
      res.end(payload);
    }
  });
}

/** Standalone entry: watch `dir`, serve on `PORT` (default 8080). */
function main(): void {
  const dir = process.env["TWILL_DOCUMENTS_DIR"] ?? "fixtures/documents";
  const port = Number(process.env["PORT"] ?? "8080");
  const store = start(dir);
  createServer(store).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[twill] registry listening on :${port} (documents: ${dir})`);
  });
}

// Run standalone only when executed directly (not under vitest/tsx import).
// tsx sets argv[1] to the resolved entry path; compare against both spellings.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("src/registry/server.ts") || process.argv[1].endsWith("src/registry/server.js"));
if (isMain) {
  main();
}
