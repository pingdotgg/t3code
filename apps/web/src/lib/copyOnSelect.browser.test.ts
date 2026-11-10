import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers } from "../../test/render";
import { createSelectionCopier, observeCopyOnSelect, readCopyableSelection } from "./copyOnSelect";
import { SELECTION_MULTI_CLICK_INTERVAL_MS } from "./selectionActions";

function mount(html: string) {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  return Object.assign(container, {
    [Symbol.dispose]: () => {
      document.getSelection()?.removeAllRanges();
      container.remove();
    },
  });
}

function textOf(root: ParentNode, selector: string): Text {
  return root.querySelector(selector)!.firstChild as Text;
}

function select(start: Text, startOffset: number, end: Text, endOffset: number) {
  document.getSelection()!.setBaseAndExtent(start, startOffset, end, endOffset);
}

function mouse(type: "mousedown" | "mouseup", target: EventTarget, init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, detail: 1, ...init }));
}

describe("readCopyableSelection", () => {
  it.each([
    ["plain text", '<p id="a">alpha</p><p id="b">bravo</p>', "alpha\n\nbravo"],
    ["a link", '<p id="a">see <a href="#">docs</a></p><p id="b">bravo</p>', "see docs\n\nbravo"],
    ["a button", '<p id="a">run <button>go</button></p><p id="b">bravo</p>', "run go\n\nbravo"],
    [
      "a citation chip",
      '<p id="a">cite <span contenteditable="false">[1]</span></p><p id="b">bravo</p>',
      "cite [1]\n\nbravo",
    ],
  ])("copies a range across %s", (_name, html, expected) => {
    using container = mount(html);
    select(textOf(container, "#a"), 0, textOf(container, "#b"), 5);
    expect(readCopyableSelection(document.getSelection(), container)).toBe(expected);
  });

  it.each([
    ["an input", '<input value="secret" />'],
    ["a textarea", "<textarea>secret</textarea>"],
    ["a select", "<select><option>secret</option></select>"],
    ["editable content", '<div contenteditable="true">secret</div>'],
    ["bare contenteditable", "<div contenteditable>secret</div>"],
    ["plaintext-only content", '<div contenteditable="plaintext-only">secret</div>'],
    ["an opted-out subtree", "<div data-no-copy-on-select>secret</div>"],
  ])("rejects a range whose ordinary endpoints cross %s", (_name, excluded) => {
    using container = mount(`<p id="a">alpha</p>${excluded}<p id="b">bravo</p>`);
    select(textOf(container, "#a"), 0, textOf(container, "#b"), 5);
    expect(readCopyableSelection(document.getSelection(), container)).toBeNull();
  });

  it("rejects selections that end in editable content, leave the container, or hold no text", () => {
    using container = mount('<p id="a">alpha</p><div id="e" contenteditable>edit</div>');
    using outside = mount('<p id="o">outside</p>');
    const alpha = textOf(container, "#a");

    select(alpha, 0, textOf(container, "#e"), 2);
    expect(readCopyableSelection(document.getSelection(), container)).toBeNull();
    select(alpha, 0, textOf(outside, "#o"), 3);
    expect(readCopyableSelection(document.getSelection(), container)).toBeNull();
    select(alpha, 2, alpha, 2);
    expect(readCopyableSelection(document.getSelection(), container)).toBeNull();
    container.querySelector("#a")!.textContent = "   ";
    select(textOf(container, "#a"), 0, textOf(container, "#a"), 3);
    expect(readCopyableSelection(document.getSelection(), container)).toBeNull();
  });
});

describe("observeCopyOnSelect", () => {
  function setup() {
    const container = mount('<p id="a">alpha bravo</p><textarea id="t">draft</textarea>');
    const copy = vi.fn();
    const stop = observeCopyOnSelect(container, copy);
    const unmount = container[Symbol.dispose];
    return Object.assign(container, {
      copy,
      text: textOf(container, "#a"),
      paragraph: container.querySelector("#a")!,
      [Symbol.dispose]: () => {
        stop();
        unmount();
      },
    });
  }

  it("copies a fresh drag, including one released outside the container", () => {
    using view = setup();
    mouse("mousedown", view.paragraph);
    select(view.text, 0, view.text, 5);
    mouse("mouseup", document.body);
    expect(view.copy).toHaveBeenCalledExactlyOnceWith("alpha");
  });

  it("ignores clicks that leave the selection unchanged, modifier clicks, and editable targets", () => {
    using view = setup();
    select(view.text, 0, view.text, 5);
    mouse("mousedown", view.paragraph);
    mouse("mouseup", view.paragraph);

    mouse("mousedown", view.paragraph, { metaKey: true });
    select(view.text, 6, view.text, 11);
    mouse("mouseup", view.paragraph, { metaKey: true });

    mouse("mousedown", view.querySelector("#t")!);
    select(view.text, 0, view.text, 11);
    mouse("mouseup", view.paragraph);

    expect(view.copy).not.toHaveBeenCalled();
  });

  it("copies a double then triple click once, after the sequence settles", () => {
    using _timers = fakeTimers();
    using view = setup();
    mouse("mousedown", view.paragraph);
    mouse("mouseup", view.paragraph);
    mouse("mousedown", view.paragraph, { detail: 2 });
    select(view.text, 0, view.text, 5);
    mouse("mouseup", view.paragraph, { detail: 2 });
    mouse("mousedown", view.paragraph, { detail: 3 });
    select(view.text, 0, view.text, 11);
    mouse("mouseup", view.paragraph, { detail: 3 });
    expect(view.copy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SELECTION_MULTI_CLICK_INTERVAL_MS);
    expect(view.copy).toHaveBeenCalledExactlyOnceWith("alpha bravo");
  });
});

describe("createSelectionCopier", () => {
  it("fails silently without touching focused input, then retries the same text", async () => {
    using input = mount('<textarea id="t">にほんご</textarea>');
    const terminalInput = input.querySelector("textarea")!;
    terminalInput.focus();
    terminalInput.setSelectionRange(4, 4);
    using execCommand = vi.spyOn(document, "execCommand");
    using writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(undefined);
    const onCopied = vi.fn();
    const copy = createSelectionCopier(onCopied);

    await expect(copy("git status")).resolves.toBe(false);
    expect(onCopied).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(terminalInput);
    expect(terminalInput.value).toBe("にほんご");
    expect([terminalInput.selectionStart, terminalInput.selectionEnd]).toEqual([4, 4]);
    expect(execCommand).not.toHaveBeenCalled();

    await expect(copy("git status")).resolves.toBe(true);
    expect(onCopied).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a write of the same text while it is in flight", async () => {
    let resolve = () => {};
    const promise = new Promise<void>((done) => (resolve = done));
    using writeText = vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(promise);
    const onCopied = vi.fn();
    const copy = createSelectionCopier(onCopied);

    const first = copy("git status");
    await expect(copy("git status")).resolves.toBe(false);
    resolve();
    await expect(first).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledOnce();
    expect(onCopied).toHaveBeenCalledOnce();
  });
});
