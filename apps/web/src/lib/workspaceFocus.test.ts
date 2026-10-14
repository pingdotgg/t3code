// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createWorkspaceFocusController } from "./workspaceFocus";

let controller: ReturnType<typeof createWorkspaceFocusController>;
function area(name: string, order: number) {
  const element = document.createElement("section");
  element.dataset.workspaceArea = name;
  element.dataset.workspaceOrder = String(order);
  element.tabIndex = -1;
  const button = document.createElement("button");
  element.append(button);
  document.body.append(element);
  return { element, button };
}
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hidden
      ? ([] as unknown as DOMRectList)
      : ([{ width: 10, height: 10 }] as unknown as DOMRectList);
  });
  controller = createWorkspaceFocusController(document);
});
afterEach(() => {
  controller.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("workspace area focus", () => {
  it("cycles in workspace order in both directions, independent of DOM order", () => {
    const panel = area("panel", 3);
    const sidebar = area("sidebar", 0);
    const conversation = area("conversation", 1);
    const composer = area("composer", 2);
    sidebar.button.focus();
    controller.move(1);
    expect(document.activeElement).toBe(conversation.element);
    controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    controller.move(1);
    expect(document.activeElement).toBe(panel.button);
    controller.move(1);
    expect(document.activeElement).toBe(sidebar.button);
    controller.move(-1);
    expect(document.activeElement).toBe(panel.button);
  });
  it("skips hidden, closed, and maximized-away areas", () => {
    const sidebar = area("sidebar", 0);
    const conversation = area("conversation", 1);
    const composer = area("composer", 2);
    const panel = area("panel", 3);
    conversation.element.dataset.chatColumnMaximizedAway = "true";
    composer.element.hidden = true;
    panel.element.dataset.workspaceUnavailable = "true";
    sidebar.button.focus();
    expect(controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(sidebar.button);
  });
  it("restores the last focused control and falls back if it was removed", () => {
    const sidebar = area("sidebar", 0);
    const composer = area("composer", 2);
    const remembered = document.createElement("button");
    composer.element.append(remembered);
    remembered.focus();
    controller.move(-1);
    controller.move(1);
    expect(document.activeElement).toBe(remembered);
    controller.move(-1);
    remembered.remove();
    controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    expect(sidebar.element.contains(document.activeElement)).toBe(false);
  });
  it("returns to the focused file-tree row inside shadow DOM", () => {
    const composer = area("composer", 2);
    const panel = area("panel", 3);
    panel.button.dataset.workspaceFocusDefault = "";
    const tree = document.createElement("file-tree-container");
    const shadow = tree.attachShadow({ mode: "open" });
    const row = document.createElement("div");
    row.setAttribute("role", "treeitem");
    row.tabIndex = 0;
    shadow.append(row);
    panel.element.append(tree);
    row.focus();
    expect(document.activeElement).toBe(tree);
    expect(controller.move(-1)).toBe(true);
    expect(document.activeElement).toBe(composer.button);
    expect(controller.move(1)).toBe(true);
    expect(shadow.activeElement).toBe(row);
    expect(document.activeElement).toBe(tree);
    controller.move(-1);
    tree.setAttribute("inert", "");
    expect(controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(panel.button);
  });
  it("falls back to a useful control if a remembered shadow host cannot take focus", () => {
    const composer = area("composer", 2);
    const panel = area("panel", 3);
    panel.button.dataset.workspaceFocusDefault = "";
    const tree = document.createElement("file-tree-container");
    const shadow = tree.attachShadow({ mode: "closed" });
    const row = document.createElement("button");
    shadow.append(row);
    panel.element.append(tree);
    row.focus();
    expect(document.activeElement).toBe(tree);
    controller.move(-1);
    expect(document.activeElement).toBe(composer.button);
    expect(controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(panel.button);
  });
  it.each([undefined, "true", "false"])(
    "keeps focus in dialogs (aria-modal=%s), including when invoked from a preview",
    (modal) => {
      area("sidebar", 0);
      area("panel", 3);
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      if (modal !== undefined) dialog.setAttribute("aria-modal", modal);
      dialog.tabIndex = -1;
      document.body.append(dialog);
      dialog.focus();
      expect(controller.move(1, "panel")).toBe(false);
      expect(document.activeElement).toBe(dialog);
    },
  );
  it.each([
    ["toast-viewport", 'role="dialog"'],
    ["toast-viewport", 'role="alertdialog"'],
    ["toast-viewport-anchored", 'role="dialog" data-slot="toast-popup"'],
  ])(
    "continues area navigation while a non-modal notification remains visible (%s, %s)",
    (viewport, attributes) => {
      const composer = area("composer", 2);
      const panel = area("panel", 4);
      const notification = document.createElement("div");
      notification.dataset.slot = viewport;
      notification.innerHTML = `<div ${attributes} aria-modal="false" tabindex="0">Provider update available<button>View update</button></div>`;
      document.body.append(notification);
      composer.button.focus();
      expect(controller.move(1)).toBe(true);
      expect(document.activeElement).toBe(panel.button);
      expect(controller.move(-1)).toBe(true);
      expect(document.activeElement).toBe(composer.button);
      expect(notification.isConnected).toBe(true);
    },
  );
  it.each([
    ['role="listbox" data-slot="select-popup"', 'role="option"'],
    ['role="menu" data-slot="menu-popup"', 'role="menuitemcheckbox"'],
    ['data-slot="popover-popup"', ""],
    ['role="dialog" aria-modal="false" data-slot="popover-popup"', ""],
    ['role="listbox"', 'role="option"'],
  ])("retains focus in an open popup (%s), then moves after it closes", (popup, item) => {
    const sidebar = area("sidebar", 0);
    const content = area("settings", 1);
    content.button.focus();
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `<div ${popup} data-open><button ${item}>Choice</button></div>`;
    document.body.append(wrapper);
    const choice = wrapper.querySelector("button")!;
    choice.focus();
    expect(controller.move(1)).toBe(false);
    expect(controller.move(-1)).toBe(false);
    expect(document.activeElement).toBe(choice);
    // Base UI can retain closed popups with nonzero geometry through their exit animation.
    wrapper.setAttribute("data-closed", "");
    wrapper.setAttribute("data-ending-style", "");
    wrapper.style.opacity = "0";
    content.button.focus();
    expect(controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(sidebar.button);
  });
  it("ignores a closed palette left in the DOM and an open tooltip", () => {
    const sidebar = area("sidebar", 0);
    const content = area("usage", 1);
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div role="dialog" data-slot="command-dialog-popup" data-closed data-ending-style style="opacity:0"><div role="listbox"></div></div><div role="tooltip" data-slot="tooltip-popup">Hint</div>',
    );
    sidebar.button.focus();
    expect(controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(content.button);
  });
  it("can leave inline Settings search results for page content", () => {
    const sidebar = area("sidebar", 0);
    const content = area("settings", 1);
    sidebar.element.innerHTML =
      '<input role="combobox" aria-expanded="true" aria-controls="results" aria-activedescendant="result"><div id="results" role="listbox"><button id="result" role="option">Accessible mode</button></div>';
    const search = sidebar.element.querySelector("input")!;
    search.focus();
    expect(controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(content.button);
    controller.move(-1);
    expect(document.activeElement).toBe(search);
    sidebar.element.querySelector("button")!.focus();
    expect(controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(content.button);
  });
  it("enters the terminal input and can leave it through the same cycle", () => {
    const composer = area("composer", 2);
    const terminal = area("terminal", 4);
    const input = document.createElement("textarea");
    input.dataset.workspaceFocusDefault = "";
    input.style.opacity = "0";
    terminal.element.append(input);
    composer.button.focus();
    controller.move(1);
    expect(document.activeElement).toBe(input);
    controller.move(-1);
    expect(document.activeElement).toBe(composer.button);
  });
  it("returns to the Pull Requests list when its focused panel closes", () => {
    area("sidebar", 0);
    const list = area("pull-requests", 1);
    const panel = area("panel", 4);
    const search = document.createElement("input");
    search.setAttribute("aria-label", "Search pull requests");
    list.element.append(search);
    search.focus();
    panel.button.focus();
    panel.element.setAttribute("inert", "");
    expect(controller.focus("content")).toBe(true);
    expect(document.activeElement).toBe(search);
  });
  it("uses the preview area when Electron retains a stale renderer focus", () => {
    const sidebar = area("sidebar", 0);
    const composer = area("composer", 2);
    area("panel", 3);
    composer.button.focus();
    controller.move(1, "panel");
    expect(document.activeElement).toBe(sidebar.button);
  });
});
