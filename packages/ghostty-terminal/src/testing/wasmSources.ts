// Test-only: Vite inlines the package's own assets so suites load the real
// libghostty-vt closure without a fetch. Nothing outside tests imports this.
import vtDataUrl from "../../assets/ghostty-vt.wasm?inline";
import writePtyDataUrl from "../../assets/ghostty-write-pty.wasm?inline";

import { type GhosttyWasmSources } from "../runtime.ts";

function decodeWasmDataUrl(dataUrl: string): Uint8Array<ArrayBuffer> {
  const encoded = dataUrl.split(",", 2)[1];
  if (!encoded) throw new Error("The Ghostty WASM data URL is invalid");
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

/** One sources object per test process, so loadGhosttyRuntime shares a runtime. */
export const testWasmSources: GhosttyWasmSources = {
  vt: decodeWasmDataUrl(vtDataUrl),
  writePty: decodeWasmDataUrl(writePtyDataUrl),
};
