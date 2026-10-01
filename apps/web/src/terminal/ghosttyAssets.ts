import { type GhosttyRuntime, loadGhosttyRuntime } from "@t3tools/ghostty-terminal/runtime";
import ghosttyVtWasmUrl from "@t3tools/ghostty-terminal/assets/ghostty-vt.wasm?url";
import ghosttyWritePtyWasmUrl from "@t3tools/ghostty-terminal/assets/ghostty-write-pty.wasm?url&no-inline";
import symbolsFontUrl from "@t3tools/ghostty-terminal/assets/SymbolsNerdFontMono-Regular.woff2?url";

/** The bundled symbols-only Nerd Font; pass it as the surface's `symbolsFontUrl`. */
export const GHOSTTY_SYMBOLS_FONT_URL = symbolsFontUrl;

async function fetchWasm(url: string, label: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to load ${label} (${response.status})`);
  }
  return response.arrayBuffer();
}

let runtimePromise: Promise<GhosttyRuntime> | null = null;

/**
 * The page's one libghostty-vt runtime. Every terminal surface (drawer panes,
 * the settings preview) shares it, so each WASM file is fetched and
 * instantiated once per page load. A failed load is forgotten so the next
 * surface retries.
 */
export function loadWebGhosttyRuntime(): Promise<GhosttyRuntime> {
  runtimePromise ??= Promise.all([
    fetchWasm(ghosttyVtWasmUrl, "libghostty-vt"),
    fetchWasm(ghosttyWritePtyWasmUrl, "the libghostty-vt PTY trampoline"),
  ])
    .then(([vt, writePty]) => loadGhosttyRuntime({ vt, writePty }))
    .catch((error: unknown) => {
      runtimePromise = null;
      throw error;
    });
  return runtimePromise;
}
