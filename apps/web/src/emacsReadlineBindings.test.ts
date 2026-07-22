import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyEmacsReadlineActionToContentEditable,
  applyEmacsReadlineActionToPlainText,
  createEmacsReadlineKeydownHandler,
  resolveEmacsReadlineAction,
} from "./emacsReadlineBindings";

function keyboardEvent(input: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">): KeyboardEvent {
  const { key, ...overrides } = input;
  return {
    altKey: false,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    key,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("resolveEmacsReadlineAction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["a", "beginning-of-line"],
    ["b", "backward-char"],
    ["d", "delete-forward"],
    ["e", "end-of-line"],
    ["f", "forward-char"],
    ["h", "delete-backward"],
    ["k", "kill-line"],
    ["n", "forward-line"],
    ["p", "previous-line"],
    ["t", "transpose-chars"],
    ["u", "unix-line-discard"],
    ["w", "backward-kill-word"],
    ["y", "yank"],
  ] as const)("maps Control-%s to %s", (key, action) => {
    expect(resolveEmacsReadlineAction(keyboardEvent({ key, ctrlKey: true }))).toBe(action);
  });

  it("uses the produced letter rather than the physical key position", () => {
    expect(
      resolveEmacsReadlineAction(keyboardEvent({ ctrlKey: true, code: "KeyQ", key: "a" })),
    ).toBe("beginning-of-line");
    expect(
      resolveEmacsReadlineAction(keyboardEvent({ altKey: true, code: "KeyN", key: "b" })),
    ).toBe("backward-word");
    expect(
      resolveEmacsReadlineAction(keyboardEvent({ altKey: true, code: "KeyB", key: "∫" })),
    ).toBeNull();
  });

  it("does not capture modified chords outside the mode", () => {
    expect(resolveEmacsReadlineAction(keyboardEvent({ key: "a", metaKey: true }))).toBeNull();
    expect(
      resolveEmacsReadlineAction(keyboardEvent({ key: "a", ctrlKey: true, shiftKey: true })),
    ).toBeNull();
  });

  it("yields before editing for app shortcuts and keybinding capture fields", () => {
    class TestElement {
      closest(selector: string): TestElement | null {
        return selector === "[data-keybinding-capture]" ? this : null;
      }
    }
    vi.stubGlobal("Element", TestElement);

    const yieldToAppShortcut = vi.fn(() => true);
    createEmacsReadlineKeydownHandler({
      shouldYieldToApplicationShortcut: yieldToAppShortcut,
    })(keyboardEvent({ key: "b", ctrlKey: true }));
    expect(yieldToAppShortcut).toHaveBeenCalledOnce();

    const captureYield = vi.fn(() => false);
    createEmacsReadlineKeydownHandler({
      shouldYieldToApplicationShortcut: captureYield,
    })({
      ...keyboardEvent({ key: "a", ctrlKey: true }),
      target: new TestElement(),
    } as unknown as KeyboardEvent);
    expect(captureYield).not.toHaveBeenCalled();
  });
});

describe("applyEmacsReadlineActionToPlainText", () => {
  const apply = (
    action: Parameters<typeof applyEmacsReadlineActionToPlainText>[0]["action"],
    value: string,
    selectionStart: number,
    selectionEnd = selectionStart,
    yankText = "",
  ) =>
    applyEmacsReadlineActionToPlainText({
      action,
      value,
      selectionStart,
      selectionEnd,
      yankText,
    });

  it("moves by character, word, and logical line", () => {
    expect(apply("backward-char", "hello", 3).selectionStart).toBe(2);
    expect(apply("forward-char", "hello", 3).selectionStart).toBe(4);
    expect(apply("backward-word", "one, two", 8).selectionStart).toBe(5);
    expect(apply("forward-word", "one, two", 0).selectionStart).toBe(3);
    expect(apply("beginning-of-line", "one\ntwo", 6).selectionStart).toBe(4);
    expect(apply("end-of-line", "one\ntwo", 4).selectionStart).toBe(7);
  });

  it("preserves the logical column for Control-N and Control-P", () => {
    const value = "abcd\nxy\n12345";
    expect(apply("forward-line", value, 3).selectionStart).toBe(7);
    expect(apply("forward-line", value, 6).selectionStart).toBe(9);
    expect(apply("previous-line", value, 11).selectionStart).toBe(7);
  });

  it("implements readline kill, discard, yank, and deletion behavior", () => {
    expect(apply("kill-line", "one two\nthree", 4)).toMatchObject({
      value: "one \nthree",
      killedText: "two",
      selectionStart: 4,
    });
    expect(apply("kill-line", "one\ntwo", 3)).toMatchObject({
      value: "onetwo",
      killedText: "\n",
    });
    expect(apply("unix-line-discard", "one two", 7)).toMatchObject({
      value: "",
      killedText: "one two",
    });
    expect(apply("backward-kill-word", "one two  ", 9)).toMatchObject({
      value: "one ",
      killedText: "two  ",
    });
    expect(apply("yank", "one ", 4, 4, "two")).toMatchObject({
      value: "one two",
      selectionStart: 7,
    });
    expect(apply("delete-backward", "abc", 2).value).toBe("ac");
    expect(apply("delete-forward", "abc", 1).value).toBe("ac");
  });

  it("does not replace a selection when the kill ring is empty", () => {
    expect(apply("yank", "selected text", 0, 8)).toEqual({
      value: "selected text",
      selectionStart: 0,
      selectionEnd: 8,
    });
  });

  it("represents boundary deletions as empty replacement ranges", () => {
    expect(apply("delete-forward", "abc", 3)).toMatchObject({
      value: "abc",
      replacementStart: 3,
      replacementEnd: 3,
    });
    expect(apply("unix-line-discard", "one\ntwo", 4)).toMatchObject({
      value: "one\ntwo",
      replacementStart: 4,
      replacementEnd: 4,
    });
  });

  it("transposes the characters around point", () => {
    expect(apply("transpose-chars", "abdc", 3)).toMatchObject({
      value: "abcd",
      selectionStart: 4,
    });
    expect(apply("transpose-chars", "acb", 3)).toMatchObject({
      value: "abc",
      selectionStart: 3,
    });
  });

  it("moves, deletes, and transposes whole Unicode code points", () => {
    expect(apply("forward-char", "😀x", 0).selectionStart).toBe(2);
    expect(apply("backward-char", "😀x", 2).selectionStart).toBe(0);
    expect(apply("delete-forward", "😀x", 0).value).toBe("x");
    expect(apply("delete-backward", "😀x", 2).value).toBe("x");
    expect(apply("transpose-chars", "😀a", 3)).toMatchObject({
      value: "a😀",
      selectionStart: 3,
    });
    expect(apply("forward-word", "𝒜x", 0).selectionStart).toBe(3);
  });
});

describe("applyEmacsReadlineActionToContentEditable", () => {
  function harness(input?: { readonly focusOutside?: boolean; readonly isCollapsed?: boolean }) {
    const inside = {} as Node;
    const outside = {} as Node;
    const modify = vi.fn();
    const selection = {
      anchorNode: inside,
      anchorOffset: 1,
      focusNode: input?.focusOutside ? outside : inside,
      focusOffset: 4,
      isCollapsed: input?.isCollapsed ?? true,
      rangeCount: 1,
      collapse: vi.fn(),
      getRangeAt: () => ({
        startContainer: inside,
        startOffset: 1,
        endContainer: inside,
        endOffset: 4,
      }),
      modify,
      toString: () => "selected",
    } as unknown as Selection & {
      modify(
        alter: "extend" | "move",
        direction: "backward" | "forward",
        granularity: string,
      ): void;
    };
    const execCommand = vi.fn(() => true);
    const document = {
      execCommand,
      getSelection: () => selection,
    } as unknown as Document;
    const host = {
      contains: (node: Node) => node === inside,
      ownerDocument: document,
    } as unknown as HTMLElement;
    return { collapse: selection.collapse, execCommand, host, modify };
  }

  it("rejects selections whose focus endpoint escapes the host", () => {
    const { execCommand, host, modify } = harness({ focusOutside: true });
    expect(applyEmacsReadlineActionToContentEditable(host, "delete-forward", "")).toEqual({
      handled: false,
    });
    expect(modify).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it.each(["delete-forward", "kill-line", "unix-line-discard", "forward-kill-word"] as const)(
    "does not turn a collapsed boundary %s into a backward deletion",
    (action) => {
      const { execCommand, host } = harness({ isCollapsed: true });
      expect(applyEmacsReadlineActionToContentEditable(host, action, "").handled).toBe(true);
      expect(execCommand).not.toHaveBeenCalled();
    },
  );

  it("preserves the selection for an empty yank and yields unsupported transpose", () => {
    const { execCommand, host } = harness({ isCollapsed: false });
    expect(applyEmacsReadlineActionToContentEditable(host, "yank", "")).toEqual({
      handled: true,
    });
    expect(applyEmacsReadlineActionToContentEditable(host, "transpose-chars", "")).toEqual({
      handled: false,
    });
    expect(execCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["backward-char", "backward", 1],
    ["forward-char", "forward", 4],
  ] as const)("collapses a selection to the %s movement boundary", (action, direction, offset) => {
    const { collapse, host, modify } = harness({ isCollapsed: false });
    expect(applyEmacsReadlineActionToContentEditable(host, action, "").handled).toBe(true);
    expect(collapse).toHaveBeenCalledWith(expect.anything(), offset);
    expect(modify).toHaveBeenCalledWith("move", direction, "character");
  });
});
