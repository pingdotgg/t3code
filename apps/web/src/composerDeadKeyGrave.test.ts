// jsdom has no bundled types. This test only needs the window it creates.
// @ts-expect-error TS7016
import { JSDOM } from "jsdom";
import { Schema } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createComposerDeadKeyGravePlugin,
  DEAD_KEY_GRAVE_LOOKALIKES,
  DEAD_KEY_GRAVE_MAX_AGE_MS,
  deadKeyGraveTextEdit,
  isPlainDeadKeyDown,
  rememberPlainDeadKey,
} from "./composerDeadKeyGrave";

const dom = new JSDOM("<!DOCTYPE html><body></body>", { pretendToBeVisual: true });
const browserGlobals = {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Text: dom.window.Text,
  HTMLElement: dom.window.HTMLElement,
  DocumentFragment: dom.window.DocumentFragment,
  getSelection: () => dom.window.getSelection(),
};
for (const [key, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
    },
    text: { group: "inline" },
  },
});

const grave = "\u02CB";

async function mount(text?: string) {
  const { EditorState, TextSelection } = await import("@tiptap/pm/state");
  const { EditorView } = await import("@tiptap/pm/view");
  const paragraph = schema.node("paragraph", null, text ? [schema.text(text)] : []);
  const plugin = createComposerDeadKeyGravePlugin();
  const doc = schema.node("doc", null, paragraph);
  let state = EditorState.create({ schema, doc, plugins: [plugin] });
  const caret = text ? 1 + text.length : 1;
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)));
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView(parent, { state });
  return { view, TextSelection };
}

describe("composer dead-key graves", () => {
  const views: Array<{ destroy: () => void }> = [];

  afterEach(() => {
    for (const view of views) view.destroy();
    views.length = 0;
    document.body.replaceChildren();
  });

  it("stores an ASCII backtick after a plain Dead key", async () => {
    const { view } = await mount();
    views.push(view);
    rememberPlainDeadKey(view);
    view.dispatch(view.state.tr.insertText(grave));
    expect(view.state.doc.textContent).toBe("`");
  });

  it("wraps a selected word in ASCII backticks", async () => {
    const { view, TextSelection } = await mount("inline code");
    views.push(view);
    rememberPlainDeadKey(view);
    const from = view.state.doc.textContent.indexOf("code") + 1;
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, from, from + "code".length))
        .insertText(grave),
    );
    expect(view.state.doc.textContent).toBe("inline `code`");
  });

  it("leaves a look-alike in place when no Dead key was pressed", async () => {
    const { view } = await mount();
    views.push(view);
    view.dispatch(view.state.tr.insertText(grave));
    expect(view.state.doc.textContent).toBe(grave);
  });

  it("leaves a look-alike in place after the dead-key window", async () => {
    const { view } = await mount();
    views.push(view);
    rememberPlainDeadKey(view, performance.now() - DEAD_KEY_GRAVE_MAX_AGE_MS - 5);
    view.dispatch(view.state.tr.insertText(grave));
    expect(view.state.doc.textContent).toBe(grave);
  });

  it("does not rewrite a pasted phrase of look-alikes", async () => {
    const { view } = await mount();
    views.push(view);
    rememberPlainDeadKey(view);
    view.dispatch(view.state.tr.insertText(`${grave}inline code${grave}`));
    expect(view.state.doc.textContent).toBe(`${grave}inline code${grave}`);
  });

  it("does not rewrite a pasted single look-alike", async () => {
    const { view } = await mount();
    views.push(view);
    rememberPlainDeadKey(view);
    view.dispatch(view.state.tr.insertText(grave).setMeta("paste", true));
    expect(view.state.doc.textContent).toBe(grave);
  });

  it("stores each grave look-alike as an ASCII backtick", async () => {
    for (const lookalike of ["\u2035", "\uFF40"]) {
      const { view } = await mount("hello");
      views.push(view);
      rememberPlainDeadKey(view);
      view.dispatch(view.state.tr.insertText(`hello${lookalike}`, 1, 1 + "hello".length));
      expect(view.state.doc.textContent).toBe("hello`");
    }
  });

  it("spends the dead key on the next edit", async () => {
    const { view } = await mount();
    views.push(view);
    rememberPlainDeadKey(view);
    view.dispatch(view.state.tr.insertText("a"));
    view.dispatch(view.state.tr.insertText(grave));
    expect(view.state.doc.textContent).toBe(`a${grave}`);
  });

  it("recognizes each dead-key grave look-alike", () => {
    for (const lookalike of DEAD_KEY_GRAVE_LOOKALIKES) {
      expect(deadKeyGraveTextEdit("code", lookalike)).toEqual({ index: 0, deleted: "code" });
    }
    expect(deadKeyGraveTextEdit("code", "`")).toBeNull();
  });

  it("treats only an unmodified Dead key as the trigger", () => {
    expect(
      isPlainDeadKeyDown({ key: "Dead", metaKey: false, ctrlKey: false, isComposing: false }),
    ).toBe(true);
    expect(
      isPlainDeadKeyDown({ key: "Dead", metaKey: true, ctrlKey: false, isComposing: false }),
    ).toBe(false);
    expect(
      isPlainDeadKeyDown({ key: "`", metaKey: false, ctrlKey: false, isComposing: false }),
    ).toBe(false);
  });
});
