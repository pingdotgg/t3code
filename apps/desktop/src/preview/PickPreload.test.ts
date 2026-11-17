import { expect, it, vi } from "vite-plus/test";

import { START_PICK_CHANNEL } from "./GuestProtocol.ts";
import "./PickPreload.ts";

const ipcListeners = vi.hoisted(() => new Map<string, Array<(...args: unknown[]) => void>>());

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      ipcListeners.set(channel, [...(ipcListeners.get(channel) ?? []), listener]);
    },
    off: () => {},
    send: () => {},
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
