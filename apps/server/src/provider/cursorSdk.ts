// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";

type CursorSdk = typeof import("@cursor/sdk");

// Cursor's Webpack chunks and local helpers must stay beside the SDK entry.
// createRequire also loads that disk-backed package from a Node SEA executable.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);
let cursorSdk: CursorSdk | undefined;

/**
 * Loads `@cursor/sdk` on first use. It takes about 300 ms and 80 MB, so a
 * server that never enables Cursor never loads it. Call it inside the effect
 * that needs the SDK, so a load failure fails that effect only.
 */
export function loadCursorSdk(): CursorSdk {
  cursorSdk ??= requireCursorSdk("@cursor/sdk") as CursorSdk;
  return cursorSdk;
}
