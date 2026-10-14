// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
  compileResolvedKeybindingsConfig,
} from "@t3tools/shared/keybindings";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ keybindings: [] as ResolvedKeybindingsConfig }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.keybindings }));
vi.mock("../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../hooks/useAccessibilitySupport", () => ({ useAccessibilitySupport: () => false }));
import { WorkspaceNavigation, useWorkspaceArea } from "./WorkspaceNavigation";
import { isContextMenuOpen, showContextMenuFallback } from "../contextMenuFallback";
import {
  queueWorkspaceFocusFromPalette,
  restoreWorkspaceFocusFromPalette,
} from "../lib/workspaceFocus";

let root: Root;
let first: HTMLTextAreaElement;
let second: HTMLButtonElement;
beforeEach(async () => {
  state.keybindings = DEFAULT_RESOLVED_KEYBINDINGS;
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    { width: 10, height: 10 },
  ] as unknown as DOMRectList);
  document.body.innerHTML =
    '<div id="mount"></div><section data-workspace-area="terminal" data-workspace-order="0" data-terminal-owner="drawer"><textarea></textarea></section><section data-workspace-area="sidebar" data-workspace-order="1"><button>Thread</button></section>';
  first = document.querySelector("textarea")!;
  second = document.querySelector("button")!;
  root = createRoot(document.getElementById("mount")!);
  await act(async () => root.render(<WorkspaceNavigation />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  document.activeElement?.dispatchEvent(event);
  return event;
}

it("handles F6 before terminal input and wraps backwards with Shift+F6", () => {
  const terminalInput = vi.fn();
  first.addEventListener("keydown", terminalInput);
  first.focus();
  expect(press("F6").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(second);
  expect(terminalInput).not.toHaveBeenCalled();
  press("F6", { shiftKey: true });
  expect(document.activeElement).toBe(first);
});

it("dismisses a custom context menu on F6 and preserves the requested destination", async () => {
  first.focus();
  const result = showContextMenuFallback([{ id: "rename", label: "Rename thread" }]);
  expect(document.activeElement?.getAttribute("role")).toBe("menu");
  press("F6");
  await expect(result).resolves.toBeNull();
  expect(isContextMenuOpen()).toBe(false);
  expect(document.activeElement).toBe(second);
});

it("uses remapped area shortcuts and leaves shortcut recording untouched", async () => {
  state.keybindings = mergeWithDefaultKeybindings(
    compileResolvedKeybindingsConfig([{ key: "ctrl+alt+g", command: "workspace.focusNext" }]),
  );
  await act(async () => root.render(<WorkspaceNavigation />));
  first.focus();
  press("g", { ctrlKey: true, altKey: true });
  expect(document.activeElement).toBe(second);
  first.dataset.keybindingCapture = "";
  first.focus();
  expect(press("F6").defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(first);
});

it("keeps F6 inside dialogs and runs palette focus commands after normal close restoration", () => {
  first.focus();
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.dataset.commandPalette = "true";
  dialog.tabIndex = -1;
  document.body.append(dialog);
  dialog.focus();
  press("F6");
  expect(document.activeElement).toBe(dialog);
  let afterClose: FrameRequestCallback | undefined;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    afterClose = callback;
    return 1;
  });
  queueWorkspaceFocusFromPalette(1);
  expect(restoreWorkspaceFocusFromPalette()).toBe(true);
  dialog.remove();
  afterClose?.(0);
  expect(document.activeElement).toBe(second);
  expect(restoreWorkspaceFocusFromPalette()).toBe(false);
});

function Page({ name }: { name: string }) {
  const contentArea = useWorkspaceArea(name, 1, name);
  return (
    <>
      <WorkspaceNavigation />
      <main {...contentArea} role="main">
        <button>First page control</button>
        <input aria-label="Page filter" />
      </main>
    </>
  );
}

it("cycles through full-page content, restores its control and handles a page change", async () => {
  first.closest("section")!.remove();
  second.closest<HTMLElement>("section")!.dataset.workspaceOrder = "0";
  await act(async () => root.render(<Page name="settings" />));
  second.focus();
  press("F6");
  expect(document.activeElement).toBe(document.querySelector("main button"));
  const filter = document.querySelector<HTMLInputElement>("main input")!;
  filter.focus();
  press("F6");
  expect(document.activeElement).toBe(second);
  press("F6", { shiftKey: true });
  expect(document.activeElement).toBe(filter);
  await act(async () => root.render(<Page name="usage" />));
  second.focus();
  press("F6");
  expect(document.activeElement).toBe(document.querySelector("main button"));
});

it("consumes F6 in a menu and resumes the cycle when a retained popup is closed", () => {
  first.focus();
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.dataset.slot = "menu-popup";
  menu.innerHTML = '<button role="menuitemcheckbox">All providers</button>';
  document.body.append(menu);
  const item = menu.querySelector("button")!;
  item.focus();
  expect(press("F6").defaultPrevented).toBe(true);
  expect(press("F6", { shiftKey: true }).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(item);
  menu.dataset.closed = "";
  menu.dataset.endingStyle = "";
  menu.style.opacity = "0";
  first.focus();
  press("F6");
  expect(document.activeElement).toBe(second);
});
