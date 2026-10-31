import * as NodeEvents from "node:events";

import { PreviewAccessibilityDocument } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildAccessibilityTree,
  isSecretField,
  ServerBrowserAccessibility,
  type AccessibilityFrameTree,
  type RawAccessibilityNode,
} from "./ServerBrowserAccessibility.ts";

const decodeDocument = Schema.decodeUnknownSync(PreviewAccessibilityDocument);

const node = (
  nodeId: string,
  role: string,
  extra: Partial<RawAccessibilityNode> & { readonly label?: string } = {},
): RawAccessibilityNode => ({
  nodeId,
  ignored: false,
  role: { value: role },
  ...(extra.label === undefined ? {} : { name: { value: extra.label } }),
  ...extra,
});
const frame = (
  key: string,
  nodes: ReadonlyArray<RawAccessibilityNode>,
  extra: Partial<AccessibilityFrameTree> = {},
): AccessibilityFrameTree => ({ key, nodes, secretNodes: new Set(), ...extra });

describe("buildAccessibilityTree", () => {
  it("omits secret field descendants as well as their values", () => {
    const { root } = buildAccessibilityTree([
      frame(
        "0",
        [
          node("1", "RootWebArea", { childIds: ["2"] }),
          node("2", "textbox", {
            label: "Code",
            backendDOMNodeId: 2,
            childIds: ["3"],
            value: { value: "654321" },
          }),
          node("3", "generic", { childIds: ["4"] }),
          node("4", "StaticText", { label: "654321" }),
        ],
        { secretNodes: new Set([2]) },
      ),
    ]);
    expect(root!.children).toEqual([
      { id: "0.2", role: "textbox", name: "Code", editable: true, protected: true },
    ]);
  });

  it("preserves spaces around inline text and links", () => {
    const { root } = buildAccessibilityTree([
      frame("0", [
        node("1", "RootWebArea", { childIds: ["2", "3", "4"] }),
        node("2", "StaticText", { label: "Read " }),
        node("3", "link", { label: "the docs" }),
        node("4", "StaticText", { label: " for help." }),
      ]),
    ]);
    expect(root!.children!.map((child) => child.name).join("")).toBe("Read the docs for help.");
  });

  it("keeps descendants of ignored and generic wrappers in reading order", () => {
    const { root } = buildAccessibilityTree([
      frame("0", [
        node("1", "RootWebArea", { label: "Page", childIds: ["2", "5"] }),
        node("2", "generic", { ignored: true, childIds: ["3", "4"] }),
        node("3", "heading", { label: "Title" }),
        node("4", "generic", { childIds: ["6"] }),
        node("5", "StaticText", { label: "After", childIds: ["7"] }),
        node("6", "link", { label: "Docs", backendDOMNodeId: 4 }),
        node("7", "InlineTextBox", { label: "After" }),
      ]),
    ]);
    expect(root).toEqual({
      id: "0.1",
      role: "document",
      name: "Page",
      children: [
        { id: "0.3", role: "heading", name: "Title" },
        { id: "0.6", role: "link", name: "Docs" },
        { id: "0.5", role: "text", name: "After" },
      ],
    });
  });

  it("places each frame under its iframe and namespaces ids by capture session", () => {
    const sameProcess = [
      node("9", "RootWebArea", { label: "Same", childIds: ["10"] }),
      node("10", "StaticText", { label: "Same-origin text" }),
    ];
    const { root, targets } = buildAccessibilityTree([
      frame("0", [
        node("1", "RootWebArea", { childIds: ["2", "3"] }),
        node("2", "Iframe", { backendDOMNodeId: 50, childIds: ["9"] }),
        node("3", "button", { label: "Main", backendDOMNodeId: 60 }),
        ...sameProcess,
      ]),
      frame(
        "1",
        [
          node("1", "RootWebArea", { label: "Ad", childIds: ["2"] }),
          node("2", "button", { label: "Inside", backendDOMNodeId: 60 }),
        ],
        { owner: { key: "0", backendNodeId: 50 } },
      ),
      // An in-process frame read again through its own frame id is not duplicated.
      frame("0", sameProcess, { owner: { key: "0", backendNodeId: 50 } }),
    ]);
    expect(root!.children).toEqual([
      {
        id: "0.9",
        role: "document",
        name: "Same",
        children: [{ id: "0.10", role: "text", name: "Same-origin text" }],
      },
      {
        id: "1.1",
        role: "document",
        name: "Ad",
        children: [{ id: "1.2", role: "button", name: "Inside" }],
      },
      { id: "0.3", role: "button", name: "Main" },
    ]);
    expect(targets.get("1.2")).toMatchObject({ key: "1", backendNodeId: 60 });
    expect(targets.get("0.3")).toMatchObject({ key: "0", backendNodeId: 60 });
  });

  it("never sends a secret or masked field value, and reads states", () => {
    const { root, targets } = buildAccessibilityTree([
      frame(
        "0",
        [
          node("1", "RootWebArea", { childIds: ["2", "3", "4", "5"] }),
          node("2", "textbox", {
            label: "Password",
            backendDOMNodeId: 2,
            value: { value: "hunter2" },
          }),
          node("3", "textbox", { label: "PIN", backendDOMNodeId: 3, value: { value: "••••" } }),
          node("4", "textbox", {
            label: "Name",
            backendDOMNodeId: 4,
            value: { value: "Ada" },
            properties: [
              { name: "readonly", value: { value: true } },
              { name: "required", value: { value: true } },
              { name: "invalid", value: { value: "false" } },
            ],
          }),
          node("5", "checkbox", {
            label: "Remember",
            backendDOMNodeId: 5,
            properties: [
              { name: "checked", value: { value: "mixed" } },
              { name: "disabled", value: { value: true } },
            ],
          }),
        ],
        { secretNodes: new Set([2]) },
      ),
    ]);
    expect(JSON.stringify(root)).not.toMatch(/hunter2|••••/u);
    expect(root!.children).toEqual([
      { id: "0.2", role: "textbox", name: "Password", protected: true, editable: true },
      { id: "0.3", role: "textbox", name: "PIN", protected: true, editable: true },
      {
        id: "0.4",
        role: "textbox",
        name: "Name",
        value: "Ada",
        readonly: true,
        required: true,
        editable: true,
      },
      { id: "0.5", role: "checkbox", name: "Remember", checked: "mixed", disabled: true },
    ]);
    expect(targets.get("0.4")).toMatchObject({ readonly: true, editable: true });
    expect(targets.get("0.5")).toMatchObject({ disabled: true });
  });

  it("stops at the node budget, marks the document truncated, and stays a valid contract", () => {
    const children = Array.from({ length: 10 }, (_, index) => `${index + 2}`);
    const built = buildAccessibilityTree(
      [
        frame("0", [
          node("1", "RootWebArea", { childIds: children }),
          ...children.map((id) => node(id, "button", { label: `B${id}` })),
        ]),
      ],
      4,
    );
    expect(built.truncated).toBe(true);
    expect(built.root!.children).toHaveLength(3);
    expect(
      decodeDocument({
        document: "1:loader",
        version: 1,
        truncated: built.truncated,
        root: built.root,
      }).root.children,
    ).toHaveLength(3);
  });
});

it("treats password and one-time-code fields as secret", () => {
  expect(isSecretField({ nodeName: "INPUT", attributes: ["type", "PASSWORD"] })).toBe(true);
  expect(isSecretField({ nodeName: "INPUT", attributes: ["autocomplete", "one-time-code"] })).toBe(
    true,
  );
  expect(isSecretField({ nodeName: "INPUT", attributes: ["type", "text"] })).toBe(false);
});

it("redelivers the newest document to a viewer whose queue was full", async () => {
  vi.useFakeTimers();
  try {
    const session = fakeSession(() => [node("1", "RootWebArea", { label: "Page" })], {
      id: "main",
    });
    const page = fakePage(session, new Map());
    const mirror = new ServerBrowserAccessibility(page as unknown as Page);
    const offer = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    await mirror.subscribe("viewer", offer);
    expect(offer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(offer).toHaveBeenCalledTimes(2);
    expect(offer.mock.calls[1]![0]).toMatchObject({ version: 1, root: { name: "Page" } });

    await mirror.unsubscribe("viewer");
    expect(page.events.eventNames()).toEqual([]);
    expect(session.events.eventNames()).toEqual([]);
    expect(session.send).toHaveBeenCalledWith("Accessibility.disable");
    expect(session.detach).toHaveBeenCalled();
    expect(
      await mirror.act({
        type: "accessibilityAction",
        document: "1:main-loader",
        node: "0.1",
        action: "activate",
      }),
    ).toBe("The page changed. Try again.");
  } finally {
    vi.useRealTimers();
  }
});

it("sends editable values exactly as typed, even when they match the field's name", () => {
  const { root } = buildAccessibilityTree([
    frame("0", [
      node("1", "RootWebArea", { childIds: ["2", "3", "4"] }),
      node("2", "textbox", {
        label: "Code",
        backendDOMNodeId: 2,
        value: { value: "  indented\n" },
      }),
      node("3", "textbox", { label: "Word", backendDOMNodeId: 3, value: { value: "Word" } }),
      node("4", "textbox", {
        label: "Spaces",
        backendDOMNodeId: 4,
        value: { value: " ".repeat(20_000) },
      }),
    ]),
  ]);
  expect(root!.children!.map((child) => child.value)).toEqual([
    "  indented\n",
    "Word",
    " ".repeat(10_000),
  ]);
});

type Listener = (...args: Array<unknown>) => void;
const fakeSession = (
  nodes: () => ReadonlyArray<RawAccessibilityNode>,
  frame: { readonly id: string; readonly parentId?: string },
) => {
  const events = new NodeEvents.EventEmitter();
  return {
    events,
    on: vi.fn((name: string, listener: Listener) => events.on(name, listener)),
    off: vi.fn((name: string, listener: Listener) => events.off(name, listener)),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, _input?: unknown) => {
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { ...frame, loaderId: `${frame.id}-loader` } } };
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: nodes() };
      if (method === "DOM.getFrameOwner") return { backendNodeId: 7 };
      if (method === "DOM.resolveNode") return { object: { objectId: "object" } };
      if (method === "DOM.describeNode") return { node: { nodeName: "INPUT", attributes: [] } };
      return {};
    }),
  };
};
const fakePage = (
  main: ReturnType<typeof fakeSession>,
  children: ReadonlyMap<object, ReturnType<typeof fakeSession> | null>,
) => {
  const events = new NodeEvents.EventEmitter();
  const page = {
    events,
    context: () => ({
      newCDPSession: async (target: object) => {
        if (target === page) return main;
        const session = children.get(target);
        if (!session) throw new Error("This frame does not have a separate CDP session.");
        return session;
      },
    }),
    mainFrame: () => page,
    frames: () => [page, ...children.keys()],
    on: (name: string, listener: Listener) => events.on(name, listener),
    off: (name: string, listener: Listener) => events.off(name, listener),
  };
  return page;
};
const captures = (session: ReturnType<typeof fakeSession>) =>
  session.send.mock.calls.filter(([method]) => method === "Accessibility.getFullAXTree").length;

it("marks the document incomplete when an embedded frame cannot be read", async () => {
  const main = fakeSession(() => [node("1", "RootWebArea", { label: "Page" })], { id: "main" });
  const page = fakePage(main, new Map([[{}, null]]));
  const mirror = new ServerBrowserAccessibility(page as unknown as Page);
  const offer = vi.fn(() => true);
  try {
    await mirror.subscribe("viewer", offer);
    expect(offer).toHaveBeenCalledWith(expect.objectContaining({ truncated: true }));
  } finally {
    await mirror.close();
  }
});

it.each([
  "DOM.scrollIntoViewIfNeeded",
  "DOM.focus",
  "DOM.resolveNode",
  "Runtime.callFunctionOn",
  "Input.insertText",
])("refuses the remaining edit after navigation during %s", async (interruptedMethod) => {
  const main = fakeSession(
    () => [
      node("1", "RootWebArea", { childIds: ["2"] }),
      node("2", "textbox", { label: "Name", backendDOMNodeId: 9 }),
    ],
    { id: "main" },
  );
  const page = fakePage(main, new Map());
  const mirror = new ServerBrowserAccessibility(page as unknown as Page);
  try {
    const offer = vi.fn(() => true);
    await mirror.subscribe("viewer", offer);
    expect(offer).toHaveBeenCalledOnce();
    const send = main.send.getMockImplementation()!;
    main.send.mockImplementation(async (method, input) => {
      const result = await send(method, input);
      if (method === interruptedMethod) page.events.emit("framenavigated", page);
      return result;
    });
    main.send.mockClear();

    expect(
      await mirror.act({
        type: "accessibilityAction",
        document: "1:main-loader",
        node: "0.2",
        action: "setValue",
        value: "Old page draft",
        submit: true,
      }),
    ).toBe("The page changed. Try again.");

    const methods = main.send.mock.calls.map(([method]) => method);
    expect(methods).toContain(interruptedMethod);
    const later = methods.slice(methods.indexOf(interruptedMethod) + 1);
    expect(later).not.toContain("Input.insertText");
    expect(later).not.toContain("Input.dispatchKeyEvent");
    expect(later).not.toContain("Runtime.callFunctionOn");
    expect(later).not.toContain("DOM.focus");
  } finally {
    await mirror.close();
  }
});

it.each(["activate", "setValue"] as const)("allows %s to navigate the page", async (action) => {
  const main = fakeSession(
    () => [
      node("1", "RootWebArea", { childIds: ["2"] }),
      node("2", action === "activate" ? "link" : "textbox", { backendDOMNodeId: 9 }),
    ],
    { id: "main" },
  );
  const page = fakePage(main, new Map());
  const mirror = new ServerBrowserAccessibility(page as unknown as Page);
  try {
    await mirror.subscribe("viewer", () => true);
    const send = main.send.getMockImplementation()!;
    const navigatingMethod =
      action === "activate" ? "Runtime.callFunctionOn" : "Input.dispatchKeyEvent";
    main.send.mockImplementation(async (method, input) => {
      const result = await send(method, input);
      if (method === navigatingMethod) page.events.emit("framenavigated", page);
      return result;
    });
    main.send.mockClear();

    expect(
      await mirror.act({
        type: "accessibilityAction",
        document: "1:main-loader",
        node: "0.2",
        action,
        value: "Draft",
        submit: true,
      }),
    ).toBeNull();
    expect(main.send).toHaveBeenCalledWith(navigatingMethod, expect.anything());
    if (action === "setValue") {
      expect(main.send).toHaveBeenCalledWith("Input.insertText", { text: "Draft" });
      expect(main.send.mock.calls.filter(([method]) => method === navigatingMethod)).toHaveLength(
        1,
      );
    }
  } finally {
    await mirror.close();
  }
});

it("follows semantic changes inside out-of-process frames and releases their sessions", async () => {
  vi.useFakeTimers();
  try {
    const mainNodes = () => [
      node("1", "RootWebArea", { childIds: ["2"] }),
      node("2", "Iframe", { backendDOMNodeId: 7 }),
    ];
    const main = fakeSession(mainNodes, { id: "main" });
    let label = "Before";
    const childNodes = () => [node("1", "RootWebArea", { label })];
    const child = fakeSession(childNodes, { id: "child", parentId: "main" });
    const childFrame = {};
    const page = fakePage(main, new Map([[childFrame, child]]));
    const mirror = new ServerBrowserAccessibility(page as unknown as Page);
    const offer = vi.fn((_document: unknown) => true);
    await mirror.subscribe("viewer", offer);
    expect(child.send).toHaveBeenCalledWith("Accessibility.enable");
    expect(offer.mock.lastCall![0]).toMatchObject({ root: { children: [{ name: "Before" }] } });

    // An ARIA-only change inside the frame repaints nothing in the main page.
    label = "After";
    child.events.emit("Accessibility.nodesUpdated", { nodes: [] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(offer.mock.lastCall![0]).toMatchObject({ root: { children: [{ name: "After" }] } });

    page.events.emit("framedetached", childFrame);
    await vi.advanceTimersByTimeAsync(0);
    expect(child.events.eventNames()).toEqual([]);
    expect(child.send).toHaveBeenCalledWith("Accessibility.disable");
    expect(child.detach).toHaveBeenCalledTimes(1);
    await mirror.unsubscribe("viewer");

    // A navigated frame's session is released at once, and its successor with the view.
    const before = fakeSession(childNodes, { id: "child", parentId: "main" });
    const after = fakeSession(childNodes, { id: "child", parentId: "main" });
    const sessions = new Map([[childFrame, before]]);
    const navigated = fakePage(main, sessions);
    const second = new ServerBrowserAccessibility(navigated as unknown as Page);
    await second.subscribe("viewer", offer);
    sessions.set(childFrame, after);
    navigated.events.emit("framenavigated", childFrame);
    await vi.advanceTimersByTimeAsync(0);
    expect(before.events.eventNames()).toEqual([]);
    expect(before.send).toHaveBeenCalledWith("Accessibility.disable");
    expect(before.detach).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(after.send).toHaveBeenCalledWith("Accessibility.enable");
    await second.unsubscribe("viewer");
    expect(after.events.eventNames()).toEqual([]);
    expect(after.send).toHaveBeenCalledWith("Accessibility.disable");
    expect(after.detach).toHaveBeenCalledTimes(1);
    expect(main.events.eventNames()).toEqual([]);
    expect(navigated.events.eventNames()).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("refuses actions on a document whose frame navigated until it is read again", async () => {
  vi.useFakeTimers();
  try {
    const nodes = () => [
      node("1", "RootWebArea", { childIds: ["2"] }),
      node("2", "button", { label: "Buy", backendDOMNodeId: 9 }),
    ];
    const main = fakeSession(nodes, { id: "main" });
    const sameProcessFrame = {};
    const page = fakePage(main, new Map([[sameProcessFrame, null]]));
    const mirror = new ServerBrowserAccessibility(page as unknown as Page);
    const offer = vi.fn((_document: unknown) => true);
    await mirror.subscribe("viewer", offer);
    const action = {
      type: "accessibilityAction" as const,
      document: "1:main-loader",
      node: "0.2",
      action: "activate" as const,
    };

    page.events.emit("framenavigated", sameProcessFrame);
    expect(await mirror.act(action)).toBe("The page changed. Try again.");
    expect(main.send).not.toHaveBeenCalledWith("Runtime.callFunctionOn", expect.anything());

    await vi.advanceTimersByTimeAsync(1_000);
    expect(captures(main)).toBe(2);
    expect(await mirror.act(action)).toBeNull();
    expect(main.send).toHaveBeenCalledWith("Runtime.callFunctionOn", expect.anything());
    await mirror.unsubscribe("viewer");
  } finally {
    vi.useRealTimers();
  }
});
