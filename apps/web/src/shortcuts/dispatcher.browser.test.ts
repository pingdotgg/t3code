import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as settings from "../hooks/useSettings";

import { dispatchMenuAction, registerCommands, registerMenuAction } from "./dispatcher";

vi.mock(import("../hooks/useSettings"), { spy: true });

function bindings(entries: ReadonlyArray<[string, KeybindingCommand]>): ResolvedKeybindingsConfig {
  return entries.map(([key, command]) => ({
    command,
    shortcut: {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
  }));
}

const keybindings = () =>
  bindings([
    ["k", "chat.new"],
    ["j", "chat.newLocal"],
  ]);

function press(
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = window,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("command dispatcher", () => {
  it("runs the newest scope's handler and nothing below it", () => {
    const global = vi.fn();
    const outer = vi.fn();
    const inner = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": global }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": outer }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": inner }, { keybindings }));

    press("k");

    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    expect(global).not.toHaveBeenCalled();
  });

  it("falls through scopes that return false, skip the command, or fail their guard", () => {
    const global = vi.fn();
    const declined = vi.fn(() => false);
    const guarded = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": global }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": declined }, { keybindings }));
    stack.defer(registerCommands({ "chat.newLocal": vi.fn() }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": guarded }, { keybindings, when: () => false }));

    press("k");

    expect(guarded).not.toHaveBeenCalled();
    expect(declined).toHaveBeenCalledOnce();
    expect(global).toHaveBeenCalledOnce();
  });

  it("stops once a handler prevents default, and unregisters on cleanup", () => {
    const lower = vi.fn();
    const upper = vi.fn((event: KeyboardEvent) => {
      event.preventDefault();
      return false;
    });
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": lower }, { keybindings }));
    const unregisterUpper = registerCommands({ "chat.new": upper }, { keybindings });

    press("k");
    expect(lower).not.toHaveBeenCalled();

    unregisterUpper();
    press("k");
    expect(upper).toHaveBeenCalledOnce();
    expect(lower).toHaveBeenCalledOnce();
  });

  it("lets a scope claim raw keys before command lookup", () => {
    const onEscape = vi.fn((event: KeyboardEvent) => (event.key === "Escape" ? undefined : false));
    const command = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": command }, { keybindings, onKeyDown: onEscape }));

    press("Escape");
    press("k");

    expect(onEscape).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledOnce();
  });

  it("tells observers whether a scope consumed the key, after the scopes ran", () => {
    const calls: Array<string> = [];
    using stack = new DisposableStack();
    stack.defer(
      registerCommands({}, { observe: (_event, consumed) => calls.push(`observe:${consumed}`) }),
    );
    stack.defer(
      registerCommands({ "chat.new": () => void calls.push("command") }, { keybindings }),
    );

    press("k");
    press("x");

    expect(calls).toEqual(["command", "observe:true", "observe:false"]);
  });

  it("consumes a command chord pressed inside a confirmation without running its handler", () => {
    const command = vi.fn();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    const cancel = document.createElement("button");
    dialog.append(cancel);
    document.body.append(dialog);
    using stack = new DisposableStack();
    stack.defer(() => dialog.remove());
    stack.defer(registerCommands({ "chat.new": command }, { keybindings }));
    cancel.focus();

    const event = new KeyboardEvent("keydown", { key: "k", cancelable: true, bubbles: true });
    cancel.dispatchEvent(event);

    expect(command).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("routes a menu action to its newest handler", () => {
    const older = vi.fn();
    const newer = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerMenuAction("test-action", older));
    const unregisterNewer = registerMenuAction("test-action", newer);

    dispatchMenuAction("test-action");
    unregisterNewer();
    dispatchMenuAction("test-action");

    expect(newer).toHaveBeenCalledOnce();
    expect(older).toHaveBeenCalledOnce();
  });

  it("limits list navigation to visible active lists without leaking raw keys", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <input id="editor" aria-controls="suggestions">
      <div id="suggestions" role="listbox"><div role="option" aria-selected="false">Alpha</div></div>
      <input id="custom" data-list-navigation="true">
      <input id="unrelated">
    `;
    document.body.append(root);
    using stack = new DisposableStack();
    stack.defer(() => root.remove());
    using setting = vi.spyOn(settings, "getClientSettings").mockReturnValue({
      ...DEFAULT_CLIENT_SETTINGS,
      vimListNavigation: true,
    });
    stack.defer(registerCommands({}));
    const keys: string[] = [];
    root.addEventListener("keydown", (event) => keys.push(event.key));
    const input = root.querySelector("#editor")!;
    const custom = root.querySelector("#custom")!;
    const keydown = (target: Element, init: KeyboardEventInit = {}) =>
      press("j", { ctrlKey: true, ...init }, target);
    for (const init of [
      { ctrlKey: false },
      { shiftKey: true },
      { altKey: true },
      { metaKey: true },
      { isComposing: true },
      { keyCode: 229 },
    ])
      expect(keydown(input, init).defaultPrevented).toBe(false);
    setting.mockReturnValue(DEFAULT_CLIENT_SETTINGS);
    expect(keydown(input).defaultPrevented).toBe(false);
    setting.mockReturnValue({ ...DEFAULT_CLIENT_SETTINGS, vimListNavigation: true });
    expect(keydown(root.querySelector("#unrelated")!).defaultPrevented).toBe(false);
    keys.length = 0;
    expect(keydown(input).defaultPrevented).toBe(true);
    expect(keydown(custom).defaultPrevented).toBe(true);
    expect(keys).toEqual(["ArrowDown", "ArrowDown"]);
    custom.setAttribute("data-list-navigation", "false");
    expect(keydown(custom).defaultPrevented).toBe(false);
    custom.setAttribute("data-list-navigation", "true");
    custom.setAttribute("hidden", "");
    expect(keydown(custom).defaultPrevented).toBe(false);
  });
});
