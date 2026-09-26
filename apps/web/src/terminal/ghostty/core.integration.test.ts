// @effect-diagnostics nodeBuiltinImport:off -- exercises the checked-in WASM artifacts.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { GhosttyTerminalCore, type GhosttyTheme } from "./core";

vi.mock("./vendor/ghostty-vt.wasm?url", () => ({ default: "test://ghostty-vt.wasm" }));
vi.mock("./vendor/ghostty-write-pty.wasm?url&no-inline", () => ({
  default: "test://ghostty-write-pty.wasm",
}));

const testTheme: GhosttyTheme = {
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  cursor: { r: 255, g: 255, b: 255 },
};

const wasmPaths = {
  "ghostty-vt.wasm": NodeURL.fileURLToPath(new URL("./vendor/ghostty-vt.wasm", import.meta.url)),
  "ghostty-write-pty.wasm": NodeURL.fileURLToPath(
    new URL("./vendor/ghostty-write-pty.wasm", import.meta.url),
  ),
} as const;

async function serveVendoredWasm(input: string | URL | Request): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const filename = Object.keys(wasmPaths).find((candidate) => url.includes(candidate));
  if (!filename) return new Response(null, { status: 404 });

  const bytes = NodeFS.readFileSync(wasmPaths[filename as keyof typeof wasmPaths]);
  return new Response(Uint8Array.from(bytes).buffer);
}

describe("GhosttyTerminalCore", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retains history through the app's configured scrollback budget", async () => {
    vi.stubGlobal("fetch", serveVendoredWasm);
    const core = await GhosttyTerminalCore.create(80, 10, 8, 16, testTheme, () => {});

    try {
      core.write(Array.from({ length: 1_200 }, (_, index) => `${index + 1}\r\n`).join(""));
      const scrollbar = core.scrollbarState();
      if (!scrollbar) throw new Error("libghostty-vt did not return scrollbar state");

      // This scenario retained only 602 rows with the previous 10,000-byte
      // configuration. The byte budget does not promise an exact row count.
      expect(scrollbar.total - scrollbar.len).toBeGreaterThan(1_000);
    } finally {
      core.dispose();
    }
  });
});
