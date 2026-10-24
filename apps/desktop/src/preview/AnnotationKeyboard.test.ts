import { describe, expect, it } from "vite-plus/test";

import { handleAnnotationKeyEvent, resolveAnnotationSubmission } from "./AnnotationKeyboard.ts";

const keyboardEvent = (
  overrides: Partial<Parameters<typeof resolveAnnotationSubmission>[0]> = {},
) => ({
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  isComposing: false,
  ...overrides,
});

describe("resolveAnnotationSubmission", () => {
  it("leaves Shift+Enter and composition events available for editing", () => {
    expect(resolveAnnotationSubmission(keyboardEvent({ shiftKey: true }), true)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ isComposing: true }), true)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ key: " " }), true)).toBeNull();
  });
});

// The annotation listener is registered first, as the preload's is, so a later
// page listener stands in for the inspected page's capture-phase shortcuts.
const dispatchKey = (
  input: {
    inOverlay?: boolean;
    commentFocused?: boolean;
    canSend?: boolean;
    isTrusted?: boolean;
  } = {},
  overrides: Partial<Parameters<typeof resolveAnnotationSubmission>[0]> = {},
  type = "keydown",
) => {
  const window = new EventTarget();
  const event = Object.assign(new Event(type, { cancelable: true }), keyboardEvent(overrides));
  Object.defineProperty(event, "isTrusted", { value: input.isTrusted ?? true });
  let action: ReturnType<typeof handleAnnotationKeyEvent> | undefined;
  let pageEvents = 0;
  window.addEventListener(type, () => {
    action = handleAnnotationKeyEvent(event, {
      overlayTarget: input.inOverlay === false ? new EventTarget() : window,
      commentFocused: input.commentFocused ?? true,
      canSend: input.canSend ?? true,
    });
  });
  window.addEventListener(type, (pageEvent) => {
    pageEvents += 1;
    pageEvent.preventDefault();
  });
  window.dispatchEvent(event);
  return { action, pageEvents, defaultPrevented: event.defaultPrevented };
};

describe("handleAnnotationKeyEvent", () => {
  it("hides overlay typing from page shortcuts without cancelling the edit", () => {
    const edits = [
      ["keydown", " "],
      ["keypress", " "],
      ["keyup", " "],
      ["keydown", "ArrowLeft"],
      ["keydown", "d"],
    ] as const;
    for (const [type, key] of edits) {
      expect(dispatchKey({}, { key }, type)).toEqual({
        action: null,
        pageEvents: 0,
        defaultPrevented: false,
      });
    }
  });

  it("submits from the focused comment and leaves multiline and IME input editable", () => {
    expect(dispatchKey()).toMatchObject({ action: "attach", defaultPrevented: true });
    expect(dispatchKey({}, { ctrlKey: true }).action).toBe("send");
    expect(dispatchKey({ canSend: false }, { metaKey: true })).toMatchObject({
      action: null,
      defaultPrevented: false,
    });
    expect(dispatchKey({ commentFocused: false }).defaultPrevented).toBe(false);
    expect(dispatchKey({}, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(dispatchKey({}, { isComposing: true }).defaultPrevented).toBe(false);
  });

  it("ignores submission and cancellation events dispatched by the page", () => {
    for (const overrides of [{}, { ctrlKey: true }, { key: "Escape" }]) {
      expect(dispatchKey({ isTrusted: false }, overrides)).toEqual({
        action: null,
        pageEvents: 0,
        defaultPrevented: false,
      });
    }
  });

  it("keeps Escape and tool shortcuts while the page keeps its own keys", () => {
    expect(dispatchKey({}, { key: "Escape" })).toEqual({
      action: "cancel",
      pageEvents: 0,
      defaultPrevented: true,
    });
    expect(dispatchKey({ inOverlay: false }, { key: " " }).pageEvents).toBe(1);
    expect(dispatchKey({ inOverlay: false }, { key: "r" }).action).toBe("marquee");
    expect(dispatchKey({ inOverlay: false }, { key: "Escape" }).action).toBe("cancel");
    expect(dispatchKey({ inOverlay: false }, { key: "r" }, "keyup").action).toBeNull();
    // The preload shares the page's realm, so the page owns Object.prototype.
    /* eslint-disable no-extend-native -- the inspected page can do this */
    const inherited = Object.getOwnPropertyDescriptor(Object.prototype, "x");
    Object.defineProperty(Object.prototype, "x", { value: "send", configurable: true });
    try {
      expect(dispatchKey({ inOverlay: false }, { key: "x" }).action).toBeNull();
    } finally {
      if (inherited) Object.defineProperty(Object.prototype, "x", inherited);
      else Reflect.deleteProperty(Object.prototype, "x");
    }
    /* eslint-enable no-extend-native */
  });
});
