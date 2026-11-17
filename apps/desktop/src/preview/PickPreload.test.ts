import { expect, it, vi } from "vite-plus/test";

import { ELEMENT_PICKED_CHANNEL, START_PICK_CHANNEL } from "./GuestProtocol.ts";
import "./PickPreload.ts";

const ipcListeners = vi.hoisted(() => new Map<string, Array<(...args: unknown[]) => void>>());
const ipcSend = vi.hoisted(() => ({ calls: [] as unknown[][] }));

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

vi.mock("react-grab/primitives", () => ({ getElementContext: async () => null }));

const startAnnotation = (): ShadowRoot => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  using attachShadow = vi.spyOn(Element.prototype, "attachShadow");
  for (const listener of ipcListeners.get(START_PICK_CHANNEL) ?? []) listener({}, undefined, false);
  const shadowRoot = attachShadow.mock.results[0]?.value;
  if (!(shadowRoot instanceof ShadowRoot)) throw new Error("annotation overlay did not start");
  return shadowRoot;
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

it("crops to the picked element's rect after the page replaces that element", async () => {
  ipcSend.calls.length = 0;
  const card = document.body.appendChild(document.createElement("div"));
  const pickedRect = new DOMRect(40, 60, 200, 120);
  // Browsers report a detached element at 0x0 in the corner.
  using _rect = vi
    .spyOn(card, "getBoundingClientRect")
    .mockImplementation(() => (card.isConnected ? pickedRect : new DOMRect()));
  document.elementsFromPoint = () => [card];
  const shadowRoot = startAnnotation();

  card.dispatchEvent(
    new PointerEvent("pointerdown", { button: 0, clientX: 100, clientY: 100, bubbles: true }),
  );
  // A polling page re-renders while the comment is written and replaces the picked node.
  card.replaceWith(document.createElement("div"));
  const attach = Array.from(shadowRoot.querySelectorAll("button")).find(
    (button) => button.textContent === "Attach",
  );
  if (!attach) throw new Error("Attach button not found");
  attach.click();

  await vi.waitFor(() =>
    expect(ipcSend.calls.some(([channel]) => channel === ELEMENT_PICKED_CHANNEL)).toBe(true),
  );
  const [, annotation] =
    ipcSend.calls.find(([channel]) => channel === ELEMENT_PICKED_CHANNEL) ?? [];
  expect((annotation as { elements: Array<{ rect: unknown }> }).elements[0]?.rect).toEqual({
    x: 40,
    y: 60,
    width: 200,
    height: 120,
  });
});
