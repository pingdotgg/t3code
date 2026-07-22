import { describe, expect, it } from "vite-plus/test";

import {
  applyEmacsReadlineActionToPlainText,
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

  it("uses physical letter codes for Alt bindings on macOS keyboard events", () => {
    expect(
      resolveEmacsReadlineAction(keyboardEvent({ altKey: true, code: "KeyB", key: "∫" })),
    ).toBe("backward-word");
  });

  it("does not capture modified chords outside the mode", () => {
    expect(resolveEmacsReadlineAction(keyboardEvent({ key: "a", metaKey: true }))).toBeNull();
    expect(
      resolveEmacsReadlineAction(keyboardEvent({ key: "a", ctrlKey: true, shiftKey: true })),
    ).toBeNull();
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
});
