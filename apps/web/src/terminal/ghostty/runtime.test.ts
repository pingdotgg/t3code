import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import wasmDataUrl from "./vendor/ghostty-vt.wasm?inline";
import writePtyWasmDataUrl from "./vendor/ghostty-write-pty.wasm?inline";
import { GhosttyRuntime } from "./runtime";

function bytesFromDataUrl(dataUrl: string): Uint8Array {
  const encoded = dataUrl.split(",", 2)[1];
  if (!encoded) throw new Error("The vendored Ghostty WASM data URL is invalid");
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

// The runtime fetches its two artifacts by URL; serve the vendored bytes instead.
function serveVendoredWasm(): void {
  vi.stubGlobal("fetch", (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const bytes = url.includes("ghostty-write-pty")
      ? bytesFromDataUrl(writePtyWasmDataUrl)
      : bytesFromDataUrl(wasmDataUrl);
    return Promise.resolve(new Response(bytes.buffer as ArrayBuffer));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GhosttyRuntime", () => {
  it("reads and writes struct fields declared through alias types", async () => {
    serveVendoredWasm();
    const runtime = await GhosttyRuntime.load();
    const layout = runtime.layout("GhosttyTerminalModeConfig");
    const config = runtime.alloc(layout.size);

    // GhosttyTerminalModeConfig.mode is a GhosttyMode alias for u16; the
    // runtime has to follow the alias to know how many bytes to write.
    runtime.setField(config, "GhosttyTerminalModeConfig", "mode", 2004);
    runtime.setField(config, "GhosttyTerminalModeConfig", "value", 1);
    expect(runtime.view(config, layout.size).getUint16(0, true)).toBe(2004);
    expect(runtime.readField(config, "GhosttyTerminalModeConfig", "mode")).toBe(2004);
    expect(runtime.readField(config, "GhosttyTerminalModeConfig", "value")).toBe(1);

    // And the terminal answers a mode query through that struct.
    const slot = runtime.allocOpaque();
    expect(runtime.call("ghostty_terminal_new", 0, slot, 80, 24)).toBe(0);
    const terminal = runtime.readPointer(slot);
    const enable = new TextEncoder().encode("\u001b[?2004h");
    const pointer = runtime.alloc(enable.length);
    runtime.bytes(pointer, enable.length).set(enable);
    runtime.call("ghostty_terminal_vt_write", terminal, pointer, enable.length);
    runtime.setField(config, "GhosttyTerminalModeConfig", "value", 0);
    expect(runtime.call("ghostty_terminal_get", terminal, 37, config)).toBe(0);
    expect(runtime.readField(config, "GhosttyTerminalModeConfig", "value")).toBe(1);

    runtime.free(pointer, enable.length);
    runtime.call("ghostty_terminal_free", terminal);
    runtime.freeOpaque(slot);
    runtime.free(config, layout.size);
  });
});
