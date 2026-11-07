import { describe, expect, it } from "vite-plus/test";

import {
  executeCommand,
  hasCommandHandler,
  isCommandEnabled,
  listPaletteCommands,
  registerCommand,
} from "./registry";

const emptyContext = {
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
};

describe("command registry", () => {
  it("runs the newest registered handler", () => {
    const calls: string[] = [];
    const disposeOlder = registerCommand("sidebar.toggle", () => {
      calls.push("older");
    });
    const disposeNewer = registerCommand("sidebar.toggle", () => {
      calls.push("newer");
    });

    expect(executeCommand("sidebar.toggle", { source: "palette" })).toBe(true);
    expect(calls).toEqual(["newer"]);
    expect(hasCommandHandler("sidebar.toggle")).toBe(true);

    disposeNewer();
    expect(executeCommand("sidebar.toggle", { source: "palette" })).toBe(true);
    expect(calls).toEqual(["newer", "older"]);

    disposeOlder();
    expect(executeCommand("sidebar.toggle", { source: "palette" })).toBe(false);
    expect(hasCommandHandler("sidebar.toggle")).toBe(false);
  });

  it("falls through handlers that return false, skipping those whose when fails", () => {
    const calls: string[] = [];
    let defaultPrevented = false;
    const event = {
      get defaultPrevented() {
        return defaultPrevented;
      },
      preventDefault() {
        defaultPrevented = true;
      },
    } as KeyboardEvent;
    using stack = new DisposableStack();
    stack.defer(
      registerCommand("chat.new", () => {
        calls.push("older");
      }),
    );
    stack.defer(
      registerCommand("chat.new", () => {
        calls.push("declined");
        return false;
      }),
    );
    stack.defer(
      registerCommand(
        "chat.new",
        () => {
          calls.push("guarded");
        },
        { when: () => false },
      ),
    );

    expect(executeCommand("chat.new", { source: "keybinding", event })).toBe(true);
    expect(calls).toEqual(["declined", "older"]);
  });

  it("stops fallthrough once a declining handler prevents default", () => {
    const calls: string[] = [];
    let defaultPrevented = false;
    const event = {
      get defaultPrevented() {
        return defaultPrevented;
      },
      preventDefault() {
        defaultPrevented = true;
      },
    } as KeyboardEvent;
    using stack = new DisposableStack();
    stack.defer(
      registerCommand("chat.new", () => {
        calls.push("older");
      }),
    );
    stack.defer(
      registerCommand("chat.new", () => {
        calls.push("consumed");
        event.preventDefault();
        return false;
      }),
    );

    expect(executeCommand("chat.new", { source: "keybinding", event })).toBe(true);
    expect(calls).toEqual(["consumed"]);
  });

  it("lists palette commands with enablement from when-clauses", () => {
    const dispose = registerCommand("terminal.split", () => undefined);
    const disabled = listPaletteCommands(emptyContext).find(
      (command) => command.id === "terminal.split",
    );
    expect(disabled?.enabled).toBe(false);
    expect(isCommandEnabled("terminal.split", emptyContext)).toBe(false);

    const enabled = listPaletteCommands({ ...emptyContext, terminalOpen: true }).find(
      (command) => command.id === "terminal.split",
    );
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.hasHandler).toBe(true);
    dispose();
  });

  it("omits commandPalette.toggle from palette listings", () => {
    expect(
      listPaletteCommands(emptyContext).some((command) => command.id === "commandPalette.toggle"),
    ).toBe(false);
  });
});
