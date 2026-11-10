import { describe, expect, it } from "vite-plus/test";

import wasmDataUrl from "./vendor/ghostty-vt.wasm?inline";
import writePtyWasmDataUrl from "./vendor/ghostty-write-pty.wasm?inline";
import pinnedVersion from "../../../../../native/libghostty-vt/VERSION?raw";

type WasmFunction = (...args: number[]) => number;

function decodeWasmDataUrl(dataUrl: string): Uint8Array {
  const encoded = dataUrl.split(",", 2)[1];
  if (!encoded) throw new Error("The vendored Ghostty WASM data URL is invalid");
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

describe("vendored libghostty-vt WebAssembly", () => {
  it("stays pinned to the canonical revision and size budget", async () => {
    const wasm = decodeWasmDataUrl(wasmDataUrl);
    expect(wasm.byteLength).toBeLessThan(750_000);

    const result = await WebAssembly.instantiate(wasm.buffer as ArrayBuffer, {
      env: { log: () => {} },
    });
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const memory = instance.exports.memory as WebAssembly.Memory;
    const call = (name: string, ...args: number[]) =>
      (instance.exports[name] as WasmFunction)(...args);
    const out = call("ghostty_wasm_alloc_u8_array", 8);
    expect(call("ghostty_build_info", 10, out)).toBe(0);
    const view = new DataView(memory.buffer, out, 8);
    const embeddedRevision = new TextDecoder().decode(
      new Uint8Array(memory.buffer, view.getUint32(0, true), view.getUint32(4, true)),
    );
    call("ghostty_wasm_free_u8_array", out, 8);
    expect(embeddedRevision).toBe(pinnedVersion.trim());
  });

  it("routes terminal-generated replies through the shared callback table", async () => {
    const mainResult = await WebAssembly.instantiate(
      decodeWasmDataUrl(wasmDataUrl).buffer as ArrayBuffer,
      { env: { log: () => {} } },
    );
    const main = mainResult instanceof WebAssembly.Instance ? mainResult : mainResult.instance;
    const memory = main.exports.memory as WebAssembly.Memory;
    let reply = "";
    const trampolineResult = await WebAssembly.instantiate(
      decodeWasmDataUrl(writePtyWasmDataUrl).buffer as ArrayBuffer,
      {
        env: {
          t3_write_pty: (_terminal: number, _userdata: number, pointer: number, length: number) => {
            reply += new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length));
          },
        },
      },
    );
    const trampoline =
      trampolineResult instanceof WebAssembly.Instance
        ? trampolineResult
        : trampolineResult.instance;
    const table = main.exports.__indirect_function_table as WebAssembly.Table;
    const callbackIndex = table.length;
    table.grow(1, trampoline.exports.ghostty_write_pty as CallableFunction);
    const call = (name: string, ...args: number[]) => (main.exports[name] as WasmFunction)(...args);
    const options = call("ghostty_wasm_alloc_u8_array", 8);
    const optionsView = new DataView(memory.buffer, options, 8);
    optionsView.setUint16(0, 80, true);
    optionsView.setUint16(2, 24, true);
    const terminalSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_terminal_new", 0, terminalSlot, options)).toBe(0);
    const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true);
    call("ghostty_terminal_set", terminal, 0, 1);
    call("ghostty_terminal_set", terminal, 1, callbackIndex);
    const query = new TextEncoder().encode("\u001b[5n");
    const queryPointer = call("ghostty_wasm_alloc_u8_array", query.length);
    new Uint8Array(memory.buffer, queryPointer, query.length).set(query);
    call("ghostty_terminal_vt_write", terminal, queryPointer, query.length);

    expect(reply).toBe("\u001b[0n");
    reply = "";
    call("ghostty_terminal_set", terminal, 1, 0);
    call("ghostty_terminal_set", terminal, 0, 0);
    call("ghostty_terminal_vt_write", terminal, queryPointer, query.length);
    expect(reply).toBe("");
    call("ghostty_terminal_set", terminal, 0, 1);
    call("ghostty_terminal_set", terminal, 1, callbackIndex);
    call("ghostty_terminal_vt_write", terminal, queryPointer, query.length);
    expect(reply).toBe("\u001b[0n");
    call("ghostty_wasm_free_u8_array", queryPointer, query.length);
    call("ghostty_terminal_free", terminal);
    call("ghostty_wasm_free_opaque", terminalSlot);
    call("ghostty_wasm_free_u8_array", options, 8);
  });
});
