import { describe, expect, it } from "vite-plus/test";

import wasmDataUrl from "./vendor/ghostty-vt.wasm?inline";
import writePtyWasmDataUrl from "./vendor/ghostty-write-pty.wasm?inline";
import pinnedVersion from "../../../../../native/libghostty-vt/VERSION?raw";
import { ghosttyKeyForCode } from "./keyCodes";

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

    // The artifact carries its own provenance: the build embeds the pinned
    // revision as semver build metadata, so the repository's canonical VERSION
    // file is the single source of truth and drift is caught here without a copy.
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

  it("creates, writes multi-codepoint graphemes, and frees repeated terminals", async () => {
    const bytes = decodeWasmDataUrl(wasmDataUrl);
    let memory: WebAssembly.Memory | null = null;
    const instantiated = await WebAssembly.instantiate(bytes.buffer as ArrayBuffer, {
      env: {
        log: () => {},
      },
    });
    const instance =
      instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
    const exports = instance.exports;
    memory = exports.memory as WebAssembly.Memory;
    const call = (name: string, ...args: number[]) => (exports[name] as WasmFunction)(...args);
    const jsonPointer = call("ghostty_type_json");
    const jsonBytes = new Uint8Array(memory.buffer, jsonPointer);
    const jsonEnd = jsonBytes.indexOf(0);
    const layouts = JSON.parse(new TextDecoder().decode(jsonBytes.subarray(0, jsonEnd))) as Record<
      string,
      { size: number }
    >;
    const optionsSize = layouts.GhosttyTerminalOptions?.size;
    expect(optionsSize).toBe(8);
    if (optionsSize === undefined) throw new Error("GhosttyTerminalOptions layout is missing");

    for (let iteration = 0; iteration < 25; iteration += 1) {
      const options = call("ghostty_wasm_alloc_u8_array", optionsSize);
      const optionsView = new DataView(memory.buffer, options, optionsSize);
      optionsView.setUint16(0, 80, true);
      optionsView.setUint16(2, 24, true);
      optionsView.setUint32(4, 5_000, true);
      const terminalSlot = call("ghostty_wasm_alloc_opaque");
      expect(call("ghostty_terminal_new", 0, terminalSlot, options)).toBe(0);
      const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true);

      const input = new TextEncoder().encode("e\u0301 👨‍👩‍👧‍👦 العربية\r\n");
      const inputPointer = call("ghostty_wasm_alloc_u8_array", input.length);
      new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
      call("ghostty_terminal_vt_write", terminal, inputPointer, input.length);
      call("ghostty_wasm_free_u8_array", inputPointer, input.length);
      call("ghostty_terminal_free", terminal);
      call("ghostty_wasm_free_opaque", terminalSlot);
      call("ghostty_wasm_free_u8_array", options, optionsSize);
    }
  });

  it("reports and scrolls the viewport with Ghostty's scrollbar state", async () => {
    const result = await WebAssembly.instantiate(
      decodeWasmDataUrl(wasmDataUrl).buffer as ArrayBuffer,
      { env: { log: () => {} } },
    );
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const memory = instance.exports.memory as WebAssembly.Memory;
    const call = (name: string, ...args: number[]) =>
      (instance.exports[name] as WasmFunction)(...args);
    const alloc = (size: number) => call("ghostty_wasm_alloc_u8_array", size);
    const options = alloc(8);
    const optionsView = new DataView(memory.buffer, options, 8);
    optionsView.setUint16(0, 80, true);
    optionsView.setUint16(2, 10, true);
    optionsView.setUint32(4, 1_000, true);
    const terminalSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_terminal_new", 0, terminalSlot, options)).toBe(0);
    const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true);
    const input = new TextEncoder().encode(
      Array.from({ length: 50 }, (_, index) => `${index + 1}\r\n`).join(""),
    );
    const inputPointer = alloc(input.length);
    new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
    call("ghostty_terminal_vt_write", terminal, inputPointer, input.length);

    const scrollbar = alloc(24);
    const scrollbarView = new DataView(memory.buffer, scrollbar, 24);
    expect(call("ghostty_terminal_get", terminal, 9, scrollbar)).toBe(0);
    expect([0, 8, 16].map((offset) => Number(scrollbarView.getBigUint64(offset, true)))).toEqual([
      51, 41, 10,
    ]);

    const scroll = alloc(24);
    const scrollView = new DataView(memory.buffer, scroll, 24);
    scrollView.setUint32(0, 2, true);
    scrollView.setInt32(8, -5, true);
    call("ghostty_terminal_scroll_viewport", terminal, scroll);
    expect(call("ghostty_terminal_get", terminal, 9, scrollbar)).toBe(0);
    expect(Number(scrollbarView.getBigUint64(8, true))).toBe(36);

    call("ghostty_wasm_free_u8_array", scroll, 24);
    call("ghostty_wasm_free_u8_array", scrollbar, 24);
    call("ghostty_wasm_free_u8_array", inputPointer, input.length);
    call("ghostty_terminal_free", terminal);
    call("ghostty_wasm_free_opaque", terminalSlot);
    call("ghostty_wasm_free_u8_array", options, 8);
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

  it("formats the active selection with Ghostty's copy semantics", async () => {
    const result = await WebAssembly.instantiate(
      decodeWasmDataUrl(wasmDataUrl).buffer as ArrayBuffer,
      { env: { log: () => {} } },
    );
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const memory = instance.exports.memory as WebAssembly.Memory;
    const call = (name: string, ...args: number[]) =>
      (instance.exports[name] as WasmFunction)(...args);
    const options = call("ghostty_wasm_alloc_u8_array", 8);
    const optionsView = new DataView(memory.buffer, options, 8);
    optionsView.setUint16(0, 80, true);
    optionsView.setUint16(2, 24, true);
    const terminalSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_terminal_new", 0, terminalSlot, options)).toBe(0);
    const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true);
    const input = new TextEncoder().encode("a\r\n\r\nb");
    const inputPointer = call("ghostty_wasm_alloc_u8_array", input.length);
    new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
    call("ghostty_terminal_vt_write", terminal, inputPointer, input.length);

    const selection = call("ghostty_wasm_alloc_u8_array", 32);
    new DataView(memory.buffer, selection, 32).setUint32(0, 32, true);
    expect(call("ghostty_terminal_select_all", terminal, selection)).toBe(0);
    expect(call("ghostty_terminal_set", terminal, 21, selection)).toBe(0);
    const formatOptions = call("ghostty_wasm_alloc_u8_array", 16);
    const formatView = new DataView(memory.buffer, formatOptions, 16);
    formatView.setUint32(0, 16, true);
    formatView.setUint8(8, 1);
    formatView.setUint8(9, 1);
    const written = call("ghostty_wasm_alloc_usize");
    expect(
      call("ghostty_terminal_selection_format_buf", terminal, formatOptions, 0, 0, written),
    ).toBe(-3);
    const outputSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const output = call("ghostty_wasm_alloc_u8_array", outputSize);
    expect(
      call(
        "ghostty_terminal_selection_format_buf",
        terminal,
        formatOptions,
        output,
        outputSize,
        written,
      ),
    ).toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, output, outputSize))).toBe(
      "a\n\nb",
    );

    call("ghostty_wasm_free_u8_array", output, outputSize);
    call("ghostty_wasm_free_usize", written);
    call("ghostty_wasm_free_u8_array", formatOptions, 16);
    call("ghostty_wasm_free_u8_array", selection, 32);
    call("ghostty_wasm_free_u8_array", inputPointer, input.length);
    call("ghostty_terminal_free", terminal);
    call("ghostty_wasm_free_opaque", terminalSlot);
    call("ghostty_wasm_free_u8_array", options, 8);
  });

  it("uses Ghostty for mouse encoding, word selection, and OSC 8 hit testing", async () => {
    const result = await WebAssembly.instantiate(
      decodeWasmDataUrl(wasmDataUrl).buffer as ArrayBuffer,
      { env: { log: () => {} } },
    );
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const memory = instance.exports.memory as WebAssembly.Memory;
    const call = (name: string, ...args: number[]) =>
      (instance.exports[name] as WasmFunction)(...args);
    const alloc = (size: number) => call("ghostty_wasm_alloc_u8_array", size);
    const free = (pointer: number, size: number) =>
      call("ghostty_wasm_free_u8_array", pointer, size);

    const terminalOptions = alloc(8);
    const terminalOptionsView = new DataView(memory.buffer, terminalOptions, 8);
    terminalOptionsView.setUint16(0, 80, true);
    terminalOptionsView.setUint16(2, 24, true);
    const terminalSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_terminal_new", 0, terminalSlot, terminalOptions)).toBe(0);
    const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true);
    const input = new TextEncoder().encode(
      "\u001b[?1000h\u001b[?1006h\u001b]8;;https://t3.codes/docs\u001b\\linked\u001b]8;;\u001b\\ plain",
    );
    const inputPointer = alloc(input.length);
    new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
    call("ghostty_terminal_vt_write", terminal, inputPointer, input.length);

    const modeFlag = alloc(1);
    new Uint8Array(memory.buffer, modeFlag, 1)[0] = 0;
    expect(call("ghostty_terminal_get", terminal, 11, modeFlag)).toBe(0);
    expect(new Uint8Array(memory.buffer, modeFlag, 1)[0]).toBe(1);
    new Uint8Array(memory.buffer, modeFlag, 1)[0] = 1;
    expect(call("ghostty_terminal_mode_get", terminal, 1003, modeFlag)).toBe(0);
    expect(new Uint8Array(memory.buffer, modeFlag, 1)[0]).toBe(0);
    const anyEventInput = new TextEncoder().encode("\u001b[?1003h");
    const anyEventPointer = alloc(anyEventInput.length);
    new Uint8Array(memory.buffer, anyEventPointer, anyEventInput.length).set(anyEventInput);
    call("ghostty_terminal_vt_write", terminal, anyEventPointer, anyEventInput.length);
    expect(call("ghostty_terminal_mode_get", terminal, 1003, modeFlag)).toBe(0);
    expect(new Uint8Array(memory.buffer, modeFlag, 1)[0]).toBe(1);
    const anyEventReset = new TextEncoder().encode("\u001b[?1003l\u001b[?1000h");
    const anyEventResetPointer = alloc(anyEventReset.length);
    new Uint8Array(memory.buffer, anyEventResetPointer, anyEventReset.length).set(anyEventReset);
    call("ghostty_terminal_vt_write", terminal, anyEventResetPointer, anyEventReset.length);
    expect(call("ghostty_terminal_mode_get", terminal, 1003, modeFlag)).toBe(0);
    expect(new Uint8Array(memory.buffer, modeFlag, 1)[0]).toBe(0);
    free(anyEventResetPointer, anyEventReset.length);
    free(anyEventPointer, anyEventInput.length);
    free(modeFlag, 1);

    const point = alloc(24);
    const pointView = new DataView(memory.buffer, point, 24);
    pointView.setUint32(0, 1, true);
    pointView.setUint16(8, 1, true);
    pointView.setUint32(12, 0, true);
    const gridRef = alloc(12);
    new DataView(memory.buffer, gridRef, 12).setUint32(0, 12, true);
    expect(call("ghostty_terminal_grid_ref", terminal, point, gridRef)).toBe(0);

    const written = call("ghostty_wasm_alloc_usize");
    expect(call("ghostty_grid_ref_hyperlink_uri", gridRef, 0, 0, written)).toBe(-3);
    const hyperlinkSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const hyperlink = alloc(hyperlinkSize);
    expect(call("ghostty_grid_ref_hyperlink_uri", gridRef, hyperlink, hyperlinkSize, written)).toBe(
      0,
    );
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, hyperlink, hyperlinkSize))).toBe(
      "https://t3.codes/docs",
    );

    const wordOptions = alloc(24);
    const wordOptionsView = new DataView(memory.buffer, wordOptions, 24);
    wordOptionsView.setUint32(0, 24, true);
    new Uint8Array(memory.buffer, wordOptions + 4, 12).set(
      new Uint8Array(memory.buffer, gridRef, 12),
    );
    const selection = alloc(32);
    new DataView(memory.buffer, selection, 32).setUint32(0, 32, true);
    expect(call("ghostty_terminal_select_word", terminal, wordOptions, selection)).toBe(0);
    expect(call("ghostty_terminal_set", terminal, 21, selection)).toBe(0);
    const formatOptions = alloc(16);
    const formatView = new DataView(memory.buffer, formatOptions, 16);
    formatView.setUint32(0, 16, true);
    formatView.setUint8(8, 1);
    formatView.setUint8(9, 1);
    expect(
      call("ghostty_terminal_selection_format_buf", terminal, formatOptions, 0, 0, written),
    ).toBe(-3);
    const selectionSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const selectionText = alloc(selectionSize);
    expect(
      call(
        "ghostty_terminal_selection_format_buf",
        terminal,
        formatOptions,
        selectionText,
        selectionSize,
        written,
      ),
    ).toBe(0);
    expect(
      new TextDecoder().decode(new Uint8Array(memory.buffer, selectionText, selectionSize)),
    ).toBe("linked");

    const lineOptions = alloc(28);
    const lineOptionsView = new DataView(memory.buffer, lineOptions, 28);
    lineOptionsView.setUint32(0, 28, true);
    new Uint8Array(memory.buffer, lineOptions + 4, 12).set(
      new Uint8Array(memory.buffer, gridRef, 12),
    );
    expect(call("ghostty_terminal_select_line", terminal, lineOptions, selection)).toBe(0);
    expect(call("ghostty_terminal_set", terminal, 21, selection)).toBe(0);
    expect(
      call("ghostty_terminal_selection_format_buf", terminal, formatOptions, 0, 0, written),
    ).toBe(-3);
    const lineSelectionSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const lineSelectionText = alloc(lineSelectionSize);
    expect(
      call(
        "ghostty_terminal_selection_format_buf",
        terminal,
        formatOptions,
        lineSelectionText,
        lineSelectionSize,
        written,
      ),
    ).toBe(0);
    expect(
      new TextDecoder().decode(new Uint8Array(memory.buffer, lineSelectionText, lineSelectionSize)),
    ).toBe("linked plain");

    const mouseEncoderSlot = call("ghostty_wasm_alloc_opaque");
    const mouseEventSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_mouse_encoder_new", 0, mouseEncoderSlot)).toBe(0);
    expect(call("ghostty_mouse_event_new", 0, mouseEventSlot)).toBe(0);
    const view = new DataView(memory.buffer);
    const mouseEncoder = view.getUint32(mouseEncoderSlot, true);
    const mouseEvent = view.getUint32(mouseEventSlot, true);
    call("ghostty_mouse_encoder_setopt_from_terminal", mouseEncoder, terminal);
    const mouseSize = alloc(36);
    const mouseSizeView = new DataView(memory.buffer, mouseSize, 36);
    for (const [offset, value] of [
      [0, 36],
      [4, 800],
      [8, 480],
      [12, 10],
      [16, 20],
    ] as const) {
      mouseSizeView.setUint32(offset, value, true);
    }
    call("ghostty_mouse_encoder_setopt", mouseEncoder, 2, mouseSize);
    call("ghostty_mouse_event_set_action", mouseEvent, 0);
    call("ghostty_mouse_event_set_button", mouseEvent, 1);
    const mousePosition = new DataView(new ArrayBuffer(8));
    mousePosition.setFloat32(0, 15, true);
    mousePosition.setFloat32(4, 25, true);
    const mousePositionPointer = alloc(8);
    new Uint8Array(memory.buffer, mousePositionPointer, 8).set(
      new Uint8Array(mousePosition.buffer),
    );
    call("ghostty_mouse_event_set_position", mouseEvent, mousePositionPointer);
    const mouseOutput = alloc(128);
    expect(
      call("ghostty_mouse_encoder_encode", mouseEncoder, mouseEvent, mouseOutput, 128, written),
    ).toBe(0);
    const mouseOutputSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    expect(
      new TextDecoder().decode(new Uint8Array(memory.buffer, mouseOutput, mouseOutputSize)),
    ).toBe("\u001b[<0;2;2M");

    call("ghostty_mouse_event_free", mouseEvent);
    call("ghostty_mouse_encoder_free", mouseEncoder);
    call("ghostty_wasm_free_opaque", mouseEventSlot);
    call("ghostty_wasm_free_opaque", mouseEncoderSlot);
    free(mousePositionPointer, 8);
    free(mouseOutput, 128);
    free(mouseSize, 36);
    free(lineSelectionText, lineSelectionSize);
    free(lineOptions, 28);
    free(selectionText, selectionSize);
    free(formatOptions, 16);
    free(selection, 32);
    free(wordOptions, 24);
    free(hyperlink, hyperlinkSize);
    call("ghostty_wasm_free_usize", written);
    free(gridRef, 12);
    free(point, 24);
    free(inputPointer, input.length);
    call("ghostty_terminal_free", terminal);
    call("ghostty_wasm_free_opaque", terminalSlot);
    free(terminalOptions, 8);
  });

  it("encodes modified printable keys in Kitty keyboard mode", async () => {
    const result = await WebAssembly.instantiate(
      decodeWasmDataUrl(wasmDataUrl).buffer as ArrayBuffer,
      { env: { log: () => {} } },
    );
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    const memory = instance.exports.memory as WebAssembly.Memory;
    const call = (name: string, ...args: number[]) =>
      (instance.exports[name] as WasmFunction)(...args);
    const alloc = (size: number) => call("ghostty_wasm_alloc_u8_array", size);
    const free = (pointer: number, size: number) =>
      call("ghostty_wasm_free_u8_array", pointer, size);

    const terminalOptions = alloc(8);
    const terminalOptionsView = new DataView(memory.buffer, terminalOptions, 8);
    terminalOptionsView.setUint16(0, 80, true);
    terminalOptionsView.setUint16(2, 24, true);
    const terminalSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_terminal_new", 0, terminalSlot, terminalOptions)).toBe(0);
    const terminal = new DataView(memory.buffer).getUint32(terminalSlot, true);
    const kittyMode = new TextEncoder().encode("\u001b[>1u");
    const kittyModePointer = alloc(kittyMode.length);
    new Uint8Array(memory.buffer, kittyModePointer, kittyMode.length).set(kittyMode);
    call("ghostty_terminal_vt_write", terminal, kittyModePointer, kittyMode.length);

    const encoderSlot = call("ghostty_wasm_alloc_opaque");
    const eventSlot = call("ghostty_wasm_alloc_opaque");
    expect(call("ghostty_key_encoder_new", 0, encoderSlot)).toBe(0);
    expect(call("ghostty_key_event_new", 0, eventSlot)).toBe(0);
    const view = new DataView(memory.buffer);
    const keyEncoder = view.getUint32(encoderSlot, true);
    const keyEvent = view.getUint32(eventSlot, true);
    call("ghostty_key_encoder_setopt_from_terminal", keyEncoder, terminal);
    call("ghostty_key_event_set_action", keyEvent, 1);
    call("ghostty_key_event_set_key", keyEvent, ghosttyKeyForCode("KeyC"));
    call("ghostty_key_event_set_mods", keyEvent, 1 << 1);
    call("ghostty_key_event_set_consumed_mods", keyEvent, 0);
    call("ghostty_key_event_set_composing", keyEvent, 0);
    call("ghostty_key_event_set_unshifted_codepoint", keyEvent, "c".codePointAt(0)!);
    const text = new TextEncoder().encode("c");
    const textPointer = alloc(text.length);
    new Uint8Array(memory.buffer, textPointer, text.length).set(text);
    call("ghostty_key_event_set_utf8", keyEvent, textPointer, text.length);

    const written = call("ghostty_wasm_alloc_usize");
    expect(call("ghostty_key_encoder_encode", keyEncoder, keyEvent, 0, 0, written)).toBe(-3);
    const outputSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const output = alloc(outputSize);
    expect(
      call("ghostty_key_encoder_encode", keyEncoder, keyEvent, output, outputSize, written),
    ).toBe(0);
    const outputLength = new DataView(memory.buffer, written, 4).getUint32(0, true);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, output, outputLength))).toBe(
      "\u001b[99;5u",
    );

    const remappedText = new TextEncoder().encode("j");
    const remappedTextPointer = alloc(remappedText.length);
    new Uint8Array(memory.buffer, remappedTextPointer, remappedText.length).set(remappedText);
    call("ghostty_key_event_set_unshifted_codepoint", keyEvent, "j".codePointAt(0)!);
    call("ghostty_key_event_set_utf8", keyEvent, remappedTextPointer, remappedText.length);
    expect(call("ghostty_key_encoder_encode", keyEncoder, keyEvent, 0, 0, written)).toBe(-3);
    const remappedOutputSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const remappedOutput = alloc(remappedOutputSize);
    expect(
      call(
        "ghostty_key_encoder_encode",
        keyEncoder,
        keyEvent,
        remappedOutput,
        remappedOutputSize,
        written,
      ),
    ).toBe(0);
    const remappedOutputLength = new DataView(memory.buffer, written, 4).getUint32(0, true);
    expect(
      new TextDecoder().decode(new Uint8Array(memory.buffer, remappedOutput, remappedOutputLength)),
    ).toBe("\u001b[106;5u");

    // Without the Kitty report-event-types flag a release encodes nothing, so
    // the surface's keyup handler stays silent for legacy sessions.
    call("ghostty_key_event_set_action", keyEvent, 0);
    expect(call("ghostty_key_encoder_encode", keyEncoder, keyEvent, 0, 0, written)).toBe(0);
    expect(new DataView(memory.buffer, written, 4).getUint32(0, true)).toBe(0);

    // With report-event-types enabled the same release encodes an event-typed code.
    const reportEvents = new TextEncoder().encode("\u001b[>3u");
    const reportEventsPointer = alloc(reportEvents.length);
    new Uint8Array(memory.buffer, reportEventsPointer, reportEvents.length).set(reportEvents);
    call("ghostty_terminal_vt_write", terminal, reportEventsPointer, reportEvents.length);
    call("ghostty_key_encoder_setopt_from_terminal", keyEncoder, terminal);
    expect(call("ghostty_key_encoder_encode", keyEncoder, keyEvent, 0, 0, written)).toBe(-3);
    const releaseSize = new DataView(memory.buffer, written, 4).getUint32(0, true);
    const releaseOutput = alloc(releaseSize);
    expect(
      call("ghostty_key_encoder_encode", keyEncoder, keyEvent, releaseOutput, releaseSize, written),
    ).toBe(0);
    const releaseLength = new DataView(memory.buffer, written, 4).getUint32(0, true);
    expect(
      new TextDecoder().decode(new Uint8Array(memory.buffer, releaseOutput, releaseLength)),
    ).toBe("\u001b[106;5:3u");
    free(releaseOutput, releaseSize);
    free(reportEventsPointer, reportEvents.length);

    free(remappedOutput, remappedOutputSize);
    free(remappedTextPointer, remappedText.length);
    free(output, outputSize);
    call("ghostty_wasm_free_usize", written);
    free(textPointer, text.length);
    call("ghostty_key_event_free", keyEvent);
    call("ghostty_key_encoder_free", keyEncoder);
    call("ghostty_wasm_free_opaque", eventSlot);
    call("ghostty_wasm_free_opaque", encoderSlot);
    free(kittyModePointer, kittyMode.length);
    call("ghostty_terminal_free", terminal);
    call("ghostty_wasm_free_opaque", terminalSlot);
    free(terminalOptions, 8);
  });
});
