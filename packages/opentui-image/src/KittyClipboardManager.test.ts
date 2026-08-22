import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "bun:test";
import * as NodeEvents from "node:events";
import type { CliRenderer } from "@opentui/core";

import { KittyClipboardManager, parseKittyClipboardPacket } from "./KittyClipboardManager.ts";

const ESC = "\x1b";
const ST = `${ESC}\\`;

function b64(value: string | Uint8Array): string {
  return NodeBuffer.Buffer.from(value).toString("base64");
}

function packet(metadata: string, payload?: string): string {
  return `${ESC}]5522;${metadata}${payload === undefined ? "" : `;${payload}`}${ST}`;
}

function createHarness(options: { readonly tmux?: boolean; readonly timeoutMs?: number } = {}) {
  const emitter = new NodeEvents.EventEmitter();
  const writes: string[] = [];
  const pastes: Array<{
    readonly bytes: Uint8Array;
    readonly metadata?: { readonly mimeType?: string; readonly kind?: string };
  }> = [];
  let oscHandler: ((sequence: string) => void) | null = null;
  const renderer = {
    capabilities: options.tmux ? { multiplexer: "tmux" } : null,
    subscribeOsc(handler: (sequence: string) => void) {
      oscHandler = handler;
      return () => {
        oscHandler = null;
      };
    },
    keyInput: {
      processPaste(
        bytes: Uint8Array,
        metadata?: { readonly mimeType?: string; readonly kind?: string },
      ) {
        pastes.push(metadata === undefined ? { bytes } : { bytes, metadata });
      },
    },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  } as unknown as CliRenderer;
  const managerOptions = {
    writer: { write: (value: string) => writes.push(value) },
    ...(options.tmux === undefined ? {} : { tmuxPassthrough: options.tmux }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  const manager = new KittyClipboardManager(renderer, managerOptions);
  return {
    manager,
    writes,
    pastes,
    emitOsc(sequence: string) {
      oscHandler?.(sequence);
    },
  };
}

describe("KittyClipboardManager", () => {
  it("parses OSC 5522 metadata and optional payload without accepting other OSC packets", () => {
    expect(
      parseKittyClipboardPacket(
        packet(`type=read:status=DATA:mime=${b64("image/png")}`, b64("png")),
      ),
    ).toEqual({
      fields: new Map([
        ["type", "read"],
        ["status", "DATA"],
        ["mime", b64("image/png")],
      ]),
      payload: b64("png"),
    });
    expect(parseKittyClipboardPacket(`${ESC}]52;c;?${ST}`)).toBeNull();
    expect(parseKittyClipboardPacket(`${ESC}]5522;type=write:status=DONE${ST}`)).toBeNull();
  });

  it("Given Kitty advertises an image, when the user pastes, then it reads and emits bounded binary bytes", () => {
    const { manager, writes, pastes, emitOsc } = createHarness();
    const deactivate = manager.activate();
    expect(writes).toEqual([`${ESC}[?5522h`]);

    emitOsc(packet("type=read:status=OK"));
    emitOsc(packet(`type=read:status=DATA:mime=${b64("text/plain")}`));
    emitOsc(packet(`type=read:status=DATA:mime=${b64("image/png")}`));
    emitOsc(packet("type=read:status=DONE"));

    expect(writes.at(-1)).toBe(packet("type=read", b64("image/png")));

    emitOsc(packet("type=read:status=OK"));
    emitOsc(packet(`type=read:status=DATA:mime=${b64("image/png")}`, b64("first")));
    emitOsc(packet(`type=read:status=DATA:mime=${b64("image/png")}`, b64("second")));
    emitOsc(packet("type=read:status=DONE"));

    expect(pastes).toHaveLength(1);
    expect(new TextDecoder().decode(pastes[0]?.bytes)).toBe("firstsecond");
    expect(pastes[0]?.metadata).toEqual({ mimeType: "image/png", kind: "binary" });

    deactivate();
    expect(writes.at(-1)).toBe(`${ESC}[?5522l`);
    manager.dispose();
  });

  it("Given a password-bearing paste event, then it returns that token using the authenticated read form", () => {
    const { manager, writes, emitOsc } = createHarness();
    manager.activate();
    emitOsc(packet("type=read:status=OK:pw=c2VjcmV0"));
    emitOsc(packet(`type=read:status=DATA:mime=${b64("image/jpeg")}`));
    emitOsc(packet("type=read:status=DONE"));

    expect(writes.at(-1)).toContain(
      `type=read:mime=${b64("image/jpeg")}:pw=c2VjcmV0:name=${b64("Paste event")}`,
    );
    manager.dispose();
  });

  it("Given only plain text is available, then rich paste mode preserves ordinary prompt paste", () => {
    const { manager, pastes, emitOsc } = createHarness();
    manager.activate();
    emitOsc(packet("type=read:status=OK"));
    emitOsc(packet(`type=read:status=DATA:mime=${b64("text/plain;charset=utf-8")}`));
    emitOsc(packet("type=read:status=DONE"));
    emitOsc(packet("type=read:status=OK"));
    emitOsc(
      packet(
        `type=read:status=DATA:mime=${b64("text/plain;charset=utf-8")}`,
        b64("line one\nline two"),
      ),
    );
    emitOsc(packet("type=read:status=DONE"));

    expect(new TextDecoder().decode(pastes[0]?.bytes)).toBe("line one\nline two");
    expect(pastes[0]?.metadata).toEqual({
      mimeType: "text/plain;charset=utf-8",
      kind: "text",
    });
    manager.dispose();
  });

  it("Given clipboard data exceeds the configured bound, then it rejects it without emitting a paste", () => {
    const { manager, pastes, emitOsc } = createHarness();
    const errors: string[] = [];
    manager.activate({ maxBytes: 4, onError: (error) => errors.push(error.message) });
    emitOsc(packet("type=read:status=OK"));
    emitOsc(packet(`type=read:status=DATA:mime=${b64("image/png")}`));
    emitOsc(packet("type=read:status=DONE"));
    emitOsc(packet("type=read:status=OK"));
    emitOsc(packet(`type=read:status=DATA:mime=${b64("image/png")}`, b64("12345")));
    emitOsc(packet("type=read:status=DONE"));

    expect(pastes).toHaveLength(0);
    expect(errors).toEqual(["Clipboard image exceeds the 10MB attachment limit."]);
    manager.dispose();
  });

  it("wraps mode and read commands for a positively identified Kitty terminal behind tmux", () => {
    const { manager, writes, emitOsc } = createHarness({ tmux: true });
    manager.activate();
    expect(writes[0]).toBe(`${ESC}Ptmux;${ESC}${ESC}[?5522h${ST}`);
    emitOsc(packet("type=read:status=OK"));
    emitOsc(packet(`type=read:status=DATA:mime=${b64("image/png")}`));
    emitOsc(packet("type=read:status=DONE"));
    expect(writes.at(-1)).toContain(`${ESC}Ptmux;${ESC}${ESC}]5522;type=read;`);
    manager.dispose();
  });
});
