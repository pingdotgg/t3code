// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import type * as RouterWorkerMainModule from "./src/worker.ts";

// Populates Cloudflare.Exports (the type of ctx.exports) with loopback
// bindings derived from the main module's exports.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof RouterWorkerMainModule;
  }
}
