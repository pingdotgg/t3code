import { expect, it, vi } from "vite-plus/test";

import { ELEMENT_PICKED_CHANNEL, START_PICK_CHANNEL } from "./GuestProtocol.ts";
import "./PickPreload.ts";

const ipcListeners = vi.hoisted(() => new Map<string, Array<(...args: unknown[]) => void>>());
const ipcSend = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      ipcListeners.set(channel, [...(ipcListeners.get(channel) ?? []), listener]);
    },
    off: () => {},
    send: ipcSend,
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

it("captures clicks inside a same-origin frame and releases them when annotation ends", () => {
  const frame = document.body.appendChild(document.createElement("iframe"));
  const frameDocument = frame.contentDocument;
  const frameWindow = frameDocument?.defaultView;
  if (!frameDocument || !frameWindow) throw new Error("same-origin frame did not load");
  const button = frameDocument.body.appendChild(frameDocument.createElement("button"));
  const click = () => {
    const event = new frameWindow.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(event);
    return event.defaultPrevented;
  };

  startAnnotation();
  expect(click(), "a click in the frame should go to the annotation, not the page").toBe(true);

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  expect(click(), "the frame should be usable again after annotation ends").toBe(false);
  frame.remove();
});

const rectAt = (left: number, top: number, width: number, height: number) =>
  DOMRect.fromRect({ x: left, y: top, width, height });

/** A 400x300 frame at (0, 100) whose button sits at frame y=-200, fully scrolled out of view. */
const selectClippedFrameButton = () => {
  const frame = document.body.appendChild(document.createElement("iframe"));
  const frameDocument = frame.contentDocument;
  const frameWindow = frameDocument?.defaultView;
  if (!frameDocument || !frameWindow) throw new Error("same-origin frame did not load");
  const button = frameDocument.body.appendChild(frameDocument.createElement("button"));
  frame.getBoundingClientRect = () => rectAt(0, 100, 400, 300);
  button.getBoundingClientRect = () => rectAt(10, -200, 100, 40);
  for (const [root, width, height] of [
    [document, 1000, 700],
    [frameDocument, 400, 300],
  ] as const) {
    Object.defineProperty(root.documentElement, "clientWidth", {
      configurable: true,
      value: width,
    });
    Object.defineProperty(root.documentElement, "clientHeight", {
      configurable: true,
      value: height,
    });
  }
  document.elementsFromPoint = () => [frame];
  frameDocument.elementsFromPoint = () => [button];

  const shadowRoot = startAnnotation();
  button.dispatchEvent(
    new frameWindow.MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      view: frameWindow,
    }),
  );
  return { frame, shadowRoot };
};

it("crops no screenshot around an element clipped out of its frame", async () => {
  const { frame, shadowRoot } = selectClippedFrameButton();
  const attach = Array.from(shadowRoot.querySelectorAll("button")).find(
    (button) => button.textContent === "Attach",
  );
  if (!attach) throw new Error("Attach button not found");
  ipcSend.mockClear();

  attach.click();
  await vi.waitFor(() => expect(ipcSend).toHaveBeenCalled());
  const [channel, annotation, screenshotRect] = ipcSend.mock.calls[0] ?? [];
  expect(channel).toBe(ELEMENT_PICKED_CHANNEL);
  expect(annotation.elements[0].rect).toMatchObject({ width: 0, height: 0 });
  expect(screenshotRect, "the frame edge strip is unrelated content").toBeNull();

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  frame.remove();
});

it("drops the selection of a frame whose document went away", () => {
  const { frame, shadowRoot } = selectClippedFrameButton();
  const editor = shadowRoot.querySelector("textarea")?.closest<HTMLElement>("[style*=display]");
  expect(editor?.style.display).toBe("flex");

  frame.remove();
  const replacement = document.body.appendChild(document.createElement("iframe"));
  replacement.dispatchEvent(new Event("load"));

  expect(editor?.style.display, "no element is left to annotate").toBe("none");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  replacement.remove();
});
