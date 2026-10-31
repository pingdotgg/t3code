import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { installSidebarTree } from "./sidebarTree";

function setup() {
  const root = document.createElement("div");
  root.setAttribute("role", "tree");
  document.body.append(root);
  let dispose: (() => void) | undefined;
  const row = (id: string, parent?: string) => {
    const element = document.createElement("button");
    element.dataset.sidebarRow = id;
    if (parent) element.dataset.sidebarParent = parent;
    element.setAttribute("role", "treeitem");
    element.textContent = id;
    root.append(element);
    return element;
  };
  return {
    root,
    row,
    install: () => {
      dispose = installSidebarTree(root);
    },
    [Symbol.dispose]() {
      dispose?.();
      root.remove();
    },
  };
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("sidebar keyboard navigation", () => {
  it("moves focus without activating rows, clamps at the ends, and keeps one Tab stop", () => {
    using tree = setup();
    const first = tree.row("first");
    const second = tree.row("second");
    const last = tree.row("last");
    const activate = vi.fn();
    tree.root.addEventListener("click", activate);
    tree.install();
    first.focus();
    press(first, "ArrowDown");
    expect(document.activeElement).toBe(second);
    press(second, "End");
    expect(document.activeElement).toBe(last);
    press(last, "ArrowDown");
    expect(document.activeElement).toBe(last);
    press(last, "Home");
    expect(document.activeElement).toBe(first);
    expect(activate).not.toHaveBeenCalled();
    expect(tree.root.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it("expands a group before entering its first child and returns to the parent", async () => {
    using tree = setup();
    const group = tree.row("project");
    group.setAttribute("aria-expanded", "false");
    group.addEventListener("click", () => {
      const expanded = group.getAttribute("aria-expanded") === "true";
      group.setAttribute("aria-expanded", String(!expanded));
      if (expanded) tree.root.querySelector('[data-sidebar-row="thread"]')?.remove();
      else tree.row("thread", "project");
    });
    tree.install();
    group.focus();
    press(group, "ArrowRight");
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(group);
    // The tree picks up the new child from its mutation observer.
    await vi.waitFor(() =>
      expect(
        tree.root.querySelector('[data-sidebar-parent="project"]')?.getAttribute("aria-level"),
      ).toBe("2"),
    );
    press(group, "ArrowRight");
    const child = document.activeElement as HTMLElement;
    expect(child.dataset.sidebarRow).toBe("thread");
    press(child, "ArrowLeft");
    expect(document.activeElement).toBe(group);
    press(group, "ArrowLeft");
    expect(group.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the row menu on Shift+F10 release without moving focus", () => {
    using tree = setup();
    tree.row("first");
    const selected = tree.row("selected");
    const contextMenu = vi.fn((event: MouseEvent) => event.preventDefault());
    selected.addEventListener("contextmenu", contextMenu);
    tree.install();
    selected.focus();
    expect(press(selected, "F10", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(contextMenu).not.toHaveBeenCalled();
    selected.dispatchEvent(
      new KeyboardEvent("keyup", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(contextMenu).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(selected);
  });

  it("lets Tab reach only the focused row's buttons", () => {
    using tree = setup();
    const first = tree.row("first");
    const second = tree.row("second");
    const action = (owner: string) => {
      const button = document.createElement("button");
      button.textContent = `Archive ${owner}`;
      button.dataset.sidebarActionFor = owner;
      tree.root.append(button);
      return button;
    };
    const firstAction = action("first");
    const secondAction = action("second");
    tree.install();
    first.focus();
    expect([firstAction.tabIndex, secondAction.tabIndex]).toEqual([0, -1]);
    press(first, "ArrowDown");
    expect(document.activeElement).toBe(second);
    expect([firstAction.tabIndex, secondAction.tabIndex]).toEqual([-1, 0]);
  });

  it("keeps a rendered row under a collapsed group reachable", () => {
    using tree = setup();
    const shelf = tree.row("shelf:settled");
    shelf.setAttribute("aria-expanded", "false");
    // A collapsed shelf still renders the open thread.
    const open = tree.row("thread", "shelf:settled");
    tree.install();
    shelf.focus();
    press(shelf, "ArrowDown");
    expect(document.activeElement).toBe(open);
  });

  it("skips disabled rows and leaves controls outside rows in the Tab order", () => {
    using tree = setup();
    const first = tree.row("first");
    const loading = tree.row("settled:more");
    loading.disabled = true;
    const undo = document.createElement("button");
    undo.textContent = "Undo";
    tree.root.append(undo);
    tree.install();
    first.focus();
    press(first, "ArrowDown");
    expect(document.activeElement).toBe(first);
    expect(undo.tabIndex).toBe(0);
  });

  it("gives row buttons back their own tab order when the tree reinstalls", () => {
    using tree = setup();
    tree.row("first");
    const second = tree.row("second");
    const action = (owner: string) => {
      const button = document.createElement("button");
      button.dataset.sidebarActionFor = owner;
      tree.root.append(button);
      return button;
    };
    const firstAction = action("first");
    const secondAction = action("second");
    const dispose = installSidebarTree(tree.root);
    second.focus();
    dispose();
    expect([firstAction.tabIndex, secondAction.tabIndex]).toEqual([0, 0]);
    tree.install();
    expect([firstAction.tabIndex, secondAction.tabIndex]).toEqual([-1, 0]);
  });

  it("keeps the scroll position when focus follows a row that moved away", async () => {
    using tree = setup();
    Object.assign(tree.root.style, { height: "100px", overflow: "auto" });
    const settled = tree.row("settled");
    const settle = document.createElement("button");
    settle.textContent = "Settle";
    settled.after(settle);
    settle.dataset.sidebarActionFor = "settled";
    for (let index = 0; index < 20; index++) tree.row(`row-${index}`).style.display = "block";
    tree.install();
    settle.focus();
    // Settling moves the row to the shelf at the bottom and removes the focused button.
    settle.remove();
    settled.remove();
    const moved = tree.row("settled");
    await vi.waitFor(() => expect(document.activeElement).toBe(moved));
    expect(tree.root.scrollTop).toBe(0);
  });

  it("does not pull focus back after a click outside the tree", async () => {
    using tree = setup();
    const first = tree.row("first");
    tree.install();
    const text = document.createElement("p");
    text.textContent = "Chat text";
    document.body.append(text);
    using _text = { [Symbol.dispose]: () => text.remove() };
    first.focus();
    await userEvent.click(text);
    expect(document.activeElement).toBe(document.body);
    // A status change re-renders the tree while the user works elsewhere.
    tree.row("second");
    await vi.waitFor(() =>
      expect(
        tree.root.querySelector('[data-sidebar-row="second"]')?.getAttribute("aria-posinset"),
      ).toBe("2"),
    );
    expect(document.activeElement).toBe(document.body);
  });
});
