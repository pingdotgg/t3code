// Imported first by every Node program a check runs on T3's code (the vitest files the
// conformance and replay tools write, `policies.mjs`, the T3 servers the diffs start):
// `fetch` reaches loopback only. T3's code fetches its model manifest from GitHub
// (`apps/server/src/provider/ModelManifest.ts`) when its provider checks run; a refused fetch
// leaves it on its bundled manifest, as on a machine without network. Checks reach no
// outside service (AGENTS.md, Safety).
//
// Importing this module installs the guard in the importing process. `GUARD_IMPORT` is the
// line that installs it in a generated source file.
import * as NodeURL from "node:url";

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])$/;

if (globalThis.__connNoOutsideFetch !== true) {
  globalThis.__connNoOutsideFetch = true;
  const original = globalThis.fetch;
  globalThis.fetch = function fetchLoopbackOnly(input, init) {
    let host = "";
    try {
      const url = typeof input === "string" || input instanceof URL ? input : input.url;
      host = new URL(String(url)).hostname;
    } catch {
      // Not a URL: refused below.
    }
    if (!LOOPBACK.test(host)) {
      return Promise.reject(new TypeError(`fetch to "${host}" refused: checks reach no outside service`));
    }
    return original.call(this, input, init);
  };
}

/** The first line of a generated source file that runs T3's code. */
export const GUARD_IMPORT = `import ${JSON.stringify(NodeURL.pathToFileURL(NodeURL.fileURLToPath(import.meta.url)).href)};\n`;

/** `node --import <this>`: the guard for a whole Node process (a T3 server or CLI). */
export const GUARD_ARG = `--import=${NodeURL.pathToFileURL(NodeURL.fileURLToPath(import.meta.url)).href}`;
