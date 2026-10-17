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
  it("attaches on Enter and sends on Cmd/Ctrl+Enter", () => {
    expect(resolveAnnotationSubmission(keyboardEvent(), true)).toBe("attach");
    expect(resolveAnnotationSubmission(keyboardEvent({ metaKey: true }), true)).toBe("send");
    expect(resolveAnnotationSubmission(keyboardEvent({ ctrlKey: true }), true)).toBe("send");
  });

  it("leaves Shift+Enter and composition events available for editing", () => {
    expect(resolveAnnotationSubmission(keyboardEvent({ shiftKey: true }), true)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ isComposing: true }), true)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ key: " " }), true)).toBeNull();
  });

  it("keeps attach available while the send shortcut follows permission changes", () => {
    const send = keyboardEvent({ ctrlKey: true });
    expect(resolveAnnotationSubmission(send, false)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent(), false)).toBe("attach");
    expect(resolveAnnotationSubmission(send, true)).toBe("send");
    expect(resolveAnnotationSubmission(send, false)).toBeNull();
    expect(resolveAnnotationSubmission(keyboardEvent({ metaKey: true }), false)).toBeNull();
  });
});

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
  const actions: Array<ReturnType<typeof handleAnnotationKeyEvent>> = [];
  let pageEvents = 0;
  window.addEventListener(type, () => {
    actions.push(
      handleAnnotationKeyEvent(event, {
        overlayTarget: input.inOverlay === false ? new EventTarget() : window,
        commentFocused: input.commentFocused ?? true,
        canSend: input.canSend ?? true,
      }),
    );
  });
  window.addEventListener(type, (pageEvent) => {
    pageEvents += 1;
    pageEvent.preventDefault();
  });
  window.dispatchEvent(event);
  return { action: actions[0], pageEvents, defaultPrevented: event.defaultPrevented };
};

describe("annotation keyboard isolation", () => {
  it.each(["keydown", "keyup", "keypress"])(
    "keeps overlay %s events from page shortcuts without cancelling text input",
    (type) => {
      expect(dispatchKey({}, { key: " " }, type)).toEqual({
        action: null,
        pageEvents: 0,
        defaultPrevented: false,
      });
    },
  );

  it("keeps caret movement and tool letters available to editor inputs", () => {
    expect(dispatchKey({}, { key: "ArrowLeft" })).toEqual({
      action: null,
      pageEvents: 0,
      defaultPrevented: false,
    });
    expect(dispatchKey({ commentFocused: false }, { key: "r" }).action).toBeNull();
    expect(dispatchKey({}, { key: "d" }).action).toBeNull();
  });

  it("submits only from the comment and preserves multiline and composition editing", () => {
    expect(dispatchKey().action).toBe("attach");
    expect(dispatchKey().defaultPrevented).toBe(true);
    expect(dispatchKey({}, { ctrlKey: true }).action).toBe("send");
    expect(dispatchKey({ canSend: false }, { metaKey: true }).defaultPrevented).toBe(false);
    expect(dispatchKey({ commentFocused: false }).defaultPrevented).toBe(false);
    expect(dispatchKey({}, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(dispatchKey({}, { isComposing: true }).defaultPrevented).toBe(false);
  });

  it("handles Escape inside the overlay before the page can consume it", () => {
    expect(dispatchKey({}, { key: "Escape" })).toEqual({
      action: "cancel",
      pageEvents: 0,
      defaultPrevented: true,
    });
  });

  it("ignores page-generated submission and cancellation events on the overlay host", () => {
    expect(dispatchKey({ isTrusted: false })).toEqual({
      action: null,
      pageEvents: 0,
      defaultPrevented: false,
    });
    expect(dispatchKey({ isTrusted: false }, { ctrlKey: true }).action).toBeNull();
    expect(dispatchKey({ isTrusted: false }, { metaKey: true }).action).toBeNull();
    expect(dispatchKey({ isTrusted: false }, { key: "Escape" }).action).toBeNull();
    expect(dispatchKey({ isTrusted: false, inOverlay: false }, { key: "r" }).action).toBeNull();
  });

  it("leaves page keyboard input and tool selection outside the overlay available", () => {
    expect(dispatchKey({ inOverlay: false }, { key: " " }).pageEvents).toBe(1);
    expect(dispatchKey({ inOverlay: false }, { key: "r" }).action).toBe("marquee");
    expect(dispatchKey({ inOverlay: false }, { key: "Escape" }).action).toBe("cancel");
    expect(dispatchKey({ inOverlay: false }, { key: "r" }, "keyup").action).toBeNull();
  });
});
