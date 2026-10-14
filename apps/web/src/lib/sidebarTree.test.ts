// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { installSidebarTree } from "./sidebarTree";

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
function row(id: string, parent?: string) {
  const element = document.createElement("button");
  element.dataset.sidebarRow = id;
  if (parent) element.dataset.sidebarParent = parent;
  element.setAttribute("role", "treeitem");
  element.textContent = id;
  root.append(element);
  return element;
}
function press(target: HTMLElement, key: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}
beforeEach(() => {
  root = document.createElement("div");
  root.setAttribute("role", "tree");
  document.body.append(root);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    { width: 10, height: 10 },
  ] as unknown as DOMRectList);
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("sidebar keyboard navigation", () => {
  it.each(["ContextMenu", "F10"])(
    "opens the focused row menu with %s without activating or changing selection",
    (key) => {
      const first = row("first");
      const selected = row("selected");
      first.setAttribute("aria-selected", "true");
      selected.setAttribute("aria-selected", "true");
      const activate = vi.fn();
      root.addEventListener("click", activate);
      const contextMenu = vi.fn((event: MouseEvent) => event.preventDefault());
      selected.addEventListener("contextmenu", contextMenu);
      vi.spyOn(selected, "getBoundingClientRect").mockReturnValue({
        left: 24,
        bottom: 128,
      } as DOMRect);
      dispose = installSidebarTree(root);
      selected.focus();
      const event = new KeyboardEvent("keydown", {
        key,
        shiftKey: key === "F10",
        bubbles: true,
        cancelable: true,
      });
      selected.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(contextMenu).not.toHaveBeenCalled();
      selected.dispatchEvent(
        new KeyboardEvent("keyup", {
          key,
          shiftKey: key === "F10",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(contextMenu).toHaveBeenCalledOnce();
      expect(contextMenu.mock.calls[0]![0]).toMatchObject({ clientX: 24, clientY: 128 });
      expect(root.querySelectorAll('[aria-selected="true"]')).toHaveLength(2);
      expect(document.activeElement).toBe(selected);
      expect(activate).not.toHaveBeenCalled();
    },
  );
  it("moves focus without activation, clamps at the ends, and has one Tab entry", () => {
    const first = row("first");
    const second = row("second");
    const last = row("last");
    const activate = vi.fn();
    root.addEventListener("click", activate);
    dispose = installSidebarTree(root);
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
    expect(root.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    // Activation remains with the existing native/React row handler.
    first.addEventListener("keydown", (event) => {
      if (event.key === "Enter") first.click();
    });
    press(first, "Enter");
    expect(activate).toHaveBeenCalledOnce();
  });

  it("expands a group before entering its first child and returns to the parent", async () => {
    const group = row("project");
    group.setAttribute("aria-expanded", "false");
    group.addEventListener("click", () => {
      const expanded = group.getAttribute("aria-expanded") === "true";
      group.setAttribute("aria-expanded", String(!expanded));
      if (expanded) root.querySelector('[data-sidebar-row="thread"]')?.remove();
      else row("thread", "project");
    });
    dispose = installSidebarTree(root);
    group.focus();
    press(group, "ArrowRight");
    await Promise.resolve();
    expect(document.activeElement).toBe(group);
    press(group, "ArrowRight");
    const child = document.activeElement as HTMLElement;
    expect(child.dataset.sidebarRow).toBe("thread");
    press(child, "ArrowLeft");
    expect(document.activeElement).toBe(group);
    press(group, "ArrowLeft");
    await Promise.resolve();
    expect(group.getAttribute("aria-expanded")).toBe("false");
  });

  it("preserves identity through reorder and chooses an adjacent row after deletion", async () => {
    const first = row("first");
    const second = row("second");
    const third = row("third");
    dispose = installSidebarTree(root);
    second.focus();
    root.prepend(third);
    await Promise.resolve();
    expect(document.activeElement).toBe(second);
    second.remove();
    await Promise.resolve();
    expect(document.activeElement).toBe(first);
    expect(first.tabIndex).toBe(0);
  });

  it("returns to a collapsed parent when its focused child disappears", async () => {
    const group = row("group");
    group.setAttribute("aria-expanded", "true");
    const child = row("child", "group");
    dispose = installSidebarTree(root);
    child.focus();
    group.setAttribute("aria-expanded", "false");
    child.remove();
    await Promise.resolve();
    expect(document.activeElement).toBe(group);
  });

  it("retains an empty tree focus target when the last row is removed", async () => {
    const only = row("only");
    dispose = installSidebarTree(root);
    only.focus();
    only.remove();
    await Promise.resolve();
    expect(document.activeElement).toBe(root);
    const replacement = row("replacement");
    await Promise.resolve();
    expect(document.activeElement).toBe(replacement);
  });

  it("keeps a valid Tab stop when rows change beneath a modal dialog", async () => {
    const workspace = document.createElement("div");
    document.body.append(workspace);
    workspace.append(root);
    row("first");
    dispose = installSidebarTree(root);
    workspace.setAttribute("inert", "");
    row("second");
    await Promise.resolve();
    workspace.removeAttribute("inert");
    expect(root.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it("leaves text editing and focus outside the tree alone", async () => {
    const first = row("first");
    const second = row("second");
    const input = document.createElement("input");
    first.append(input);
    dispose = installSidebarTree(root);
    input.focus();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    second.remove();
    await Promise.resolve();
    expect(document.activeElement).toBe(outside);
  });

  it("exposes row actions with F2 and restores the single tree entry with Escape", () => {
    const first = row("first");
    const archive = document.createElement("button");
    archive.textContent = "Archive";
    first.append(archive);
    const create = document.createElement("button");
    create.dataset.sidebarActionFor = "first";
    root.append(create);
    dispose = installSidebarTree(root);
    first.focus();
    expect(archive.tabIndex).toBe(-1);
    press(first, "F2");
    expect(document.activeElement).toBe(archive);
    expect(create.tabIndex).toBe(0);
    press(archive, "Escape");
    expect(document.activeElement).toBe(first);
    expect(archive.tabIndex).toBe(-1);
    expect(create.tabIndex).toBe(-1);
  });

  it("reveals the destination before focus and only changes two Tab stops in a large list", () => {
    const entries = Array.from({ length: 2000 }, (_, index) => row(`thread-${index}`));
    dispose = installSidebarTree(root);
    entries[0]!.focus();
    const observer = new MutationObserver(() => {});
    observer.observe(root, { attributes: true, subtree: true, attributeFilter: ["tabindex"] });
    const last = entries.at(-1)!;
    vi.mocked(last.scrollIntoView).mockImplementation(function (this: HTMLElement) {
      expect(document.activeElement).not.toBe(this);
    });
    press(entries[0]!, "End");
    expect(document.activeElement).toBe(last);
    expect(observer.takeRecords()).toHaveLength(2);
    observer.disconnect();
  });
});
