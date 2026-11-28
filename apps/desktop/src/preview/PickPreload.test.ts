import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { ELEMENT_PICKED_CHANNEL, START_PICK_CHANNEL } from "./GuestProtocol.ts";
import "./PickPreload.ts";

const ipcListeners = vi.hoisted(() => new Map<string, Array<(...args: unknown[]) => void>>());
const ipcSend = vi.hoisted(() => ({ calls: [] as unknown[][] }));
const pageElementContext = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      ipcListeners.set(channel, [...(ipcListeners.get(channel) ?? []), listener]);
    },
    off: () => {},
    send: (...args: unknown[]) => {
      ipcSend.calls.push(args);
    },
    invoke: async () => undefined,
  },
}));

vi.mock("./PageWorldBridge.ts", () => ({ pageWorld: { elementContext: pageElementContext } }));

const startAnnotation = (): ShadowRoot => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // jsdom has no popover API.
  HTMLElement.prototype.showPopover ??= () => {};
  HTMLElement.prototype.hidePopover ??= () => {};
  // jsdom has no adoptedStyleSheets.
  for (const target of [Document.prototype, ShadowRoot.prototype]) {
    if (!("adoptedStyleSheets" in target)) {
      Object.defineProperty(target, "adoptedStyleSheets", { value: [], writable: true });
    }
  }
  using attachShadow = vi.spyOn(Element.prototype, "attachShadow");
  for (const listener of ipcListeners.get(START_PICK_CHANNEL) ?? []) listener({}, undefined, false);
  const shadowRoot = attachShadow.mock.results[0]?.value;
  if (!(shadowRoot instanceof ShadowRoot)) throw new Error("annotation overlay did not start");
  return shadowRoot;
};

const pickAndAttach = async (element: Element) => {
  ipcSend.calls.length = 0;
  document.elementsFromPoint = () => [element];
  using listeners = vi.spyOn(HTMLButtonElement.prototype, "addEventListener");
  const shadowRoot = startAnnotation();
  element.dispatchEvent(
    new PointerEvent("pointerdown", { button: 0, clientX: 100, clientY: 100, bubbles: true }),
  );
  const attach = Array.from(shadowRoot.querySelectorAll("button")).find(
    (button) => button.textContent === "Attach",
  );
  const listenerIndex = listeners.mock.contexts.findIndex(
    (target, index) => target === attach && listeners.mock.calls[index]?.[0] === "click",
  );
  const listener = listeners.mock.calls[listenerIndex]?.[1];
  if (!attach || typeof listener !== "function") throw new Error("Attach listener not found");
  // The DOM test environment has no native input source.
  listener.call(attach, { isTrusted: true } as MouseEvent);

  await vi.waitFor(() =>
    expect(ipcSend.calls.some(([channel]) => channel === ELEMENT_PICKED_CHANNEL)).toBe(true),
  );
  const [, annotation] =
    ipcSend.calls.find(([channel]) => channel === ELEMENT_PICKED_CHANNEL) ?? [];
  return (annotation as PreviewAnnotationPayload | undefined)?.elements[0]?.element;
};

it("switches tools from the keyboard after a toolbar button is clicked", () => {
  const shadowRoot = startAnnotation();
  const region = Array.from(shadowRoot.querySelectorAll("button")).find(
    (button) => button.textContent === "Region",
  );
  if (!region) throw new Error("Region toolbar button not found");

  region.focus();
  region.click();
  expect(document.documentElement.getAttribute("data-t3code-annotation-tool")).toBe("marquee");

  region.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true, composed: true }));

  expect(
    document.documentElement.getAttribute("data-t3code-annotation-tool"),
    "V should switch to Select while focus is on a toolbar button",
  ).toBe("select");
});

it("erases a drawn stroke only when the pointer hits it", () => {
  const shadowRoot = startAnnotation();
  const pointer = (target: EventTarget, type: string, clientX: number, clientY: number) =>
    target.dispatchEvent(
      new PointerEvent(type, { clientX, clientY, bubbles: true, composed: true }),
    );
  const tool = (key: string) =>
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  tool("d");
  pointer(document.body, "pointerdown", 100, 100);
  pointer(document.body, "pointermove", 200, 200);
  pointer(document.body, "pointerup", 200, 200);
  const attach = Array.from(shadowRoot.querySelectorAll("button")).find(
    (button) => button.textContent === "Attach",
  )!;
  expect(attach.disabled).toBe(false);

  tool("e");
  pointer(document.body, "pointerdown", 120, 180);
  expect(attach.disabled).toBe(false);

  // jsdom has no layout or hit testing. Dispatch at the target the browser would hit.
  const hit = shadowRoot.querySelector('path[pointer-events="stroke"]')!;
  Object.defineProperty(shadowRoot, "elementFromPoint", { value: () => hit });
  pointer(hit, "pointerdown", 150, 155);
  expect(attach.disabled).toBe(true);
});

it("keeps the tool while typing a tool key in the comment", () => {
  const shadowRoot = startAnnotation();
  const comment = shadowRoot.querySelector("textarea");
  if (!comment) throw new Error("comment textarea not found");

  comment.focus();
  comment.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, composed: true }));

  expect(document.documentElement.getAttribute("data-t3code-annotation-tool")).toBe("select");
});

it("keeps comment keystrokes away from the page's capture-phase shortcuts", () => {
  const pageShortcut = vi.fn((event: KeyboardEvent) => event.preventDefault());
  window.addEventListener("keydown", pageShortcut, { capture: true });
  const shadowRoot = startAnnotation();
  const comment = shadowRoot.querySelector("textarea");
  if (!comment) throw new Error("comment textarea not found");

  comment.focus();
  const space = new KeyboardEvent("keydown", {
    key: " ",
    code: "Space",
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  comment.dispatchEvent(space);
  window.removeEventListener("keydown", pageShortcut, { capture: true });

  expect(pageShortcut).not.toHaveBeenCalled();
  expect(space.defaultPrevented).toBe(false);
});

it("keeps the annotation when Escape dismisses an IME candidate in the comment", () => {
  const shadowRoot = startAnnotation();
  const comment = shadowRoot.querySelector("textarea");
  if (!comment) throw new Error("comment textarea not found");

  comment.value = "draft";
  comment.focus();
  comment.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      isComposing: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );

  expect(shadowRoot.host.isConnected).toBe(true);
  expect(comment.value).toBe("draft");
});

it.each([
  { scrolled: false, rect: { x: 40, y: 60, width: 200, height: 120 } },
  // The last rect would point at whatever now sits there, so no crop beats a wrong one.
  { scrolled: true, rect: { x: 0, y: 0, width: 0, height: 0 } },
])(
  "submits a replaced element's last rect unless the page scrolled ($scrolled)",
  async ({ scrolled, rect }) => {
    ipcSend.calls.length = 0;
    const card = document.body.appendChild(document.createElement("div"));
    const pickedRect = new DOMRect(40, 60, 200, 120);
    // Browsers report a detached element at 0x0 in the corner.
    using _rect = vi
      .spyOn(card, "getBoundingClientRect")
      .mockImplementation(() => (card.isConnected ? pickedRect : new DOMRect()));
    document.elementsFromPoint = () => [card];
    using listeners = vi.spyOn(HTMLButtonElement.prototype, "addEventListener");
    const shadowRoot = startAnnotation();

    card.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 100, clientY: 100, bubbles: true }),
    );
    // A polling page re-renders while the comment is written and replaces the picked node.
    card.replaceWith(document.createElement("div"));
    if (scrolled) window.dispatchEvent(new Event("scroll"));
    const attach = Array.from(shadowRoot.querySelectorAll("button")).find(
      (button) => button.textContent === "Attach",
    );
    if (!attach) throw new Error("Attach button not found");
    attach.click();
    expect(attach.disabled).toBe(false);
    expect(ipcSend.calls.some(([channel]) => channel === ELEMENT_PICKED_CHANNEL)).toBe(false);
    const listenerIndex = listeners.mock.contexts.findIndex(
      (target, index) => target === attach && listeners.mock.calls[index]?.[0] === "click",
    );
    const listener = listeners.mock.calls[listenerIndex]?.[1];
    if (typeof listener !== "function") throw new Error("Attach click listener not found");
    // The DOM test environment has no native input source.
    listener.call(attach, { isTrusted: true } as MouseEvent);

    await vi.waitFor(() =>
      expect(ipcSend.calls.some(([channel]) => channel === ELEMENT_PICKED_CHANNEL)).toBe(true),
    );
    const [, annotation] =
      ipcSend.calls.find(([channel]) => channel === ELEMENT_PICKED_CHANNEL) ?? [];
    expect((annotation as { elements: Array<{ rect: unknown }> }).elements[0]?.rect).toEqual(rect);
  },
);

it("keeps only the well-typed fields of what the page reports about an element", async () => {
  pageElementContext.mockResolvedValueOnce({
    selector: { toString: () => "#object" },
    htmlPreview: "<button>Pay</button>",
    componentName: 7,
    styles: null,
    stack: [{ functionName: "Checkout", fileName: ["x"], lineNumber: "12", columnNumber: 4 }, 3],
  });
  const card = document.body.appendChild(document.createElement("div"));
  const element = await pickAndAttach(card);
  const frame = { functionName: "Checkout", fileName: null, lineNumber: null, columnNumber: 4 };
  expect(element).toMatchObject({
    selector: null,
    htmlPreview: "<button>Pay</button>",
    componentName: null,
    styles: "",
    source: frame,
    stack: [frame, { functionName: null, fileName: null, lineNumber: null, columnNumber: null }],
  });
});

it("drops a straddling surrogate pair when falling back to outerHTML preview", async () => {
  pageElementContext.mockRejectedValueOnce(new Error("page lookup failed"));
  const card = document.body.appendChild(document.createElement("div"));
  card.textContent = `${"a".repeat(494)}🚀tail`;
  expect(card.outerHTML.charCodeAt(499)).toBe(0xd83d);
  expect((await pickAndAttach(card))?.htmlPreview).toBe(card.outerHTML.slice(0, 499));
});
