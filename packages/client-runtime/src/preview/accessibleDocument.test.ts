import type { PreviewAccessibilityNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planAccessibleNode, syncChildren } from "./accessibleDocument.ts";

const plan = (node: PreviewAccessibilityNode, canAct = true) => planAccessibleNode(node, canAct);

describe("planAccessibleNode", () => {
  it("renders headings, links and landmarks as their native elements", () => {
    expect(plan({ id: "1", role: "heading", name: "Cart", level: 9 })).toMatchObject({
      tag: "h6",
      text: "Cart",
    });
    expect(
      plan({ id: "2", role: "link", name: "Docs", url: "https://t3.codes/docs" }),
    ).toMatchObject({
      tag: "a",
      attributes: { href: "https://t3.codes/docs" },
      control: "activate",
    });
    // Script URLs never become live links in the viewer's own document.
    expect(plan({ id: "3", role: "link", name: "Run", url: "javascript:alert(1)" })).toMatchObject({
      tag: "a",
      attributes: { role: "link", tabindex: "0" },
    });
    expect(plan({ id: "4", role: "navigation", name: "Primary" })).toMatchObject({
      tag: "nav",
      attributes: { "aria-label": "Primary" },
    });
  });

  it("keeps controls reachable but inert for viewers without control", () => {
    expect(plan({ id: "1", role: "button", name: "Pay", pressed: "true" }, false)).toMatchObject({
      tag: "button",
      attributes: { type: "button", "aria-pressed": "true", "aria-disabled": "true" },
      control: "activate",
    });
    expect(plan({ id: "2", role: "textbox", name: "Name", value: "Ada" }, false)).toMatchObject({
      tag: "input",
      attributes: { type: "text", readonly: "" },
      value: "Ada",
    });
  });

  it("shows secret fields as empty password inputs and multiline fields as text areas", () => {
    expect(
      plan({ id: "1", role: "textbox", name: "Password", protected: true, editable: true }),
    ).toMatchObject({ tag: "input", attributes: { type: "password" }, value: "" });
    expect(plan({ id: "2", role: "textbox", name: "Bio", multiline: true })).toMatchObject({
      tag: "textarea",
      control: "edit",
    });
  });

  it("turns comboboxes with options into a native select and checkboxes into inputs", () => {
    expect(
      plan({
        id: "1",
        role: "combobox",
        name: "Size",
        children: [
          {
            id: "2",
            role: "listbox",
            children: [
              { id: "3", role: "option", name: "Small" },
              { id: "4", role: "option", name: "Large", selected: true },
            ],
          },
        ],
      }),
    ).toMatchObject({
      tag: "select",
      control: "select",
      options: [
        { id: "3", label: "Small", selected: false },
        { id: "4", label: "Large", selected: true },
      ],
    });
    expect(plan({ id: "5", role: "checkbox", name: "All", checked: "mixed" })).toMatchObject({
      tag: "input",
      attributes: { type: "checkbox" },
      checked: false,
      indeterminate: true,
    });
  });

  it("keeps an expanded tree item's nested items as their own controls", () => {
    const file = { id: "4", role: "treeitem", name: "index.ts", selected: false };
    const folder = {
      id: "1",
      role: "treeitem",
      name: "src",
      expanded: true,
      selected: true,
      children: [
        { id: "2", role: "text", name: "src" },
        { id: "3", role: "group", children: [file] },
      ],
    };
    const shown = plan(folder);
    expect(shown).toMatchObject({
      tag: "div",
      attributes: {
        role: "treeitem",
        tabindex: "0",
        "aria-label": "src",
        "aria-expanded": "true",
        "aria-selected": "true",
      },
      control: "activate",
      children: folder.children,
    });
    expect(shown).not.toHaveProperty("text");
    expect(plan(file)).toMatchObject({
      tag: "div",
      attributes: { role: "treeitem", tabindex: "0", "aria-selected": "false" },
      text: "index.ts",
      control: "activate",
    });
  });

  it("skips empty presentational nodes and keeps text", () => {
    expect(plan({ id: "1", role: "image" })).toBeNull();
    expect(plan({ id: "2", role: "unknownwidget" })).toBeNull();
    expect(plan({ id: "3", role: "text", name: "Hello" })).toEqual({ kind: "text", text: "Hello" });
  });
});

interface FakeNode {
  readonly name: string;
  parentNode: FakeParent | null;
  readonly contains: (other: FakeNode | null) => boolean;
  readonly nextSibling: FakeNode | null;
}
interface FakeParent {
  readonly childNodes: Array<FakeNode>;
  readonly insertBefore: (child: FakeNode, before: FakeNode | null) => FakeNode;
  readonly removeChild: (child: FakeNode) => FakeNode;
}

/** Records every placement, since the DOM blurs a focused element whenever it moves. */
const fakeParent = (names: ReadonlyArray<string>) => {
  const moved: Array<string> = [];
  const parent: FakeParent = {
    childNodes: [],
    insertBefore: (child, before) => {
      if (child.parentNode) parent.removeChild(child);
      moved.push(child.name);
      const index = before ? parent.childNodes.indexOf(before) : parent.childNodes.length;
      parent.childNodes.splice(index, 0, child);
      child.parentNode = parent;
      return child;
    },
    removeChild: (child) => {
      parent.childNodes.splice(parent.childNodes.indexOf(child), 1);
      child.parentNode = null;
      return child;
    },
  };
  const make = (name: string): FakeNode => {
    const node: FakeNode = {
      name,
      parentNode: null,
      contains: (other) => other === node,
      get nextSibling() {
        const siblings = node.parentNode?.childNodes ?? [];
        return siblings[siblings.indexOf(node) + 1] ?? null;
      },
    };
    return node;
  };
  const nodes = new Map(names.map((name) => [name, make(name)]));
  for (const node of nodes.values()) parent.insertBefore(node, null);
  moved.length = 0;
  const get = (name: string) => nodes.get(name) ?? nodes.set(name, make(name)).get(name)!;
  const sync = (next: ReadonlyArray<string>, focused?: string) =>
    syncChildren(
      parent as unknown as Element,
      next.map(get) as unknown as ReadonlyArray<Node>,
      (focused ? get(focused) : null) as unknown as Node | null,
    );
  const order = () => parent.childNodes.map((node) => node.name);
  return { moved, sync, order };
};

describe("syncChildren", () => {
  it("never moves a focused child that keeps its place among survivors", () => {
    const removal = fakeParent(["A", "B"]);
    removal.sync(["B"], "B");
    expect(removal.order()).toEqual(["B"]);
    expect(removal.moved).toEqual([]);

    const swap = fakeParent(["A", "B", "C"]);
    swap.sync(["B", "C", "A", "D"], "B");
    expect(swap.order()).toEqual(["B", "C", "A", "D"]);
    expect(swap.moved).not.toContain("B");

    const forward = fakeParent(["C", "D", "B"]);
    forward.sync(["B", "C", "D"], "B");
    expect(forward.order()).toEqual(["B", "C", "D"]);
    expect(forward.moved).not.toContain("B");
  });

  it("reorders, inserts and removes children to match", () => {
    const list = fakeParent(["A", "B", "C", "D"]);
    list.sync(["D", "E", "B"]);
    expect(list.order()).toEqual(["D", "E", "B"]);
  });
});
