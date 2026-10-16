import { describe, expect, it, vi } from "vite-plus/test";

import { sendPageCommand, toKeyboardInputEvents } from "./GuestInput.ts";

/** A guest whose page reports `focusedDocument` for the focus probe. */
const makeGuest = ({
  focused,
  focusedDocument = true,
}: {
  readonly focused: boolean;
  readonly focusedDocument?: boolean;
}) => {
  const sendCommand = vi.fn(async (method: string, params?: { expression?: string }) =>
    method === "Runtime.evaluate" && params?.expression?.endsWith("!== null")
      ? { result: { value: focusedDocument } }
      : { result: {} },
  );
  const webContents = {
    focusedFrame: focused ? {} : null,
    insertText: vi.fn(async () => {}),
    sendInputEvent: vi.fn(),
  };
  return {
    webContents,
    sendCommand,
    send: (method: string, params: Record<string, unknown>) =>
      sendPageCommand(
        webContents as unknown as Electron.WebContents,
        { sendCommand } as unknown as Electron.Debugger,
        method,
        params,
      ),
  };
};

describe("preview guest input", () => {
  it("types into an unfocused guest's own page, not the app's focused field", async () => {
    const guest = makeGuest({ focused: false });
    await guest.send("Input.insertText", { text: "pairing-code" });
    expect(guest.webContents.insertText).toHaveBeenCalledWith("pairing-code");
    expect(guest.sendCommand).not.toHaveBeenCalledWith("Input.insertText", expect.anything());
  });

  it("uses CDP input while the guest holds focus, where it already reaches the page", async () => {
    const guest = makeGuest({ focused: true });
    await guest.send("Input.insertText", { text: "x" });
    await guest.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a" });
    expect(guest.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      "Input.insertText",
      "Input.dispatchKeyEvent",
    ]);
    expect(guest.webContents.insertText).not.toHaveBeenCalled();
  });

  it("refuses input when a cross-site frame holds the unfocused page's focus", async () => {
    const guest = makeGuest({ focused: false, focusedDocument: false });
    await expect(guest.send("Input.insertText", { text: "secret" })).rejects.toThrow(
      /cross-site frame/,
    );
    expect(guest.webContents.insertText).not.toHaveBeenCalled();
  });

  it("clears a field with Cmd+A and Delete while unfocused, never touching the clipboard", async () => {
    const guest = makeGuest({ focused: false });
    await guest.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      modifiers: 4,
      commands: ["selectAll", "paste"],
    });
    await guest.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete" });
    expect(guest.webContents.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "rawKeyDown", keyCode: "a", modifiers: ["meta"] },
      { type: "rawKeyDown", keyCode: "Delete", modifiers: [] },
    ]);
    const scripts = guest.sendCommand.mock.calls.map(([, params]) => params?.expression ?? "");
    expect(scripts.some((script) => script.includes('["selectAll"]'))).toBe(true);
    expect(scripts.some((script) => script.includes("paste"))).toBe(false);
  });

  it("does not run other page commands through the guest's direct input", async () => {
    const guest = makeGuest({ focused: false });
    await guest.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 });
    expect(guest.sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 1,
      y: 1,
    });
    expect(guest.webContents.sendInputEvent).not.toHaveBeenCalled();
  });
});

describe("CDP key events as Electron input", () => {
  it("sends a key's text as char events after its key down", () => {
    expect(toKeyboardInputEvents({ type: "keyDown", key: "Enter", text: "\r" })).toEqual([
      { type: "rawKeyDown", keyCode: "Enter", modifiers: [] },
      { type: "char", keyCode: "\r", modifiers: [] },
    ]);
    expect(toKeyboardInputEvents({ type: "keyDown", key: "é", text: "é", modifiers: 8 })).toEqual([
      { type: "rawKeyDown", keyCode: "é", modifiers: ["shift"] },
      { type: "char", keyCode: "é", modifiers: ["shift"] },
    ]);
  });

  it("names arrows and function keys as Electron accelerators", () => {
    expect(toKeyboardInputEvents({ type: "keyUp", key: "ArrowLeft", modifiers: 3 })).toEqual([
      { type: "keyUp", keyCode: "Left", modifiers: ["alt", "control"] },
    ]);
    expect(toKeyboardInputEvents({ type: "rawKeyDown", key: "F12" })).toEqual([
      { type: "rawKeyDown", keyCode: "F12", modifiers: [] },
    ]);
    expect(toKeyboardInputEvents({ type: "rawKeyDown", key: "AudioVolumeUp" })).toEqual([]);
  });
});
