import { DEFAULT_THEMES, preloadHighlighter } from "@pierre/diffs";
import { Editor, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider, File } from "@pierre/diffs/react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

import { isMacPlatform } from "~/lib/utils";
import { installFileEditorDismissal } from "./fileEditorDismissal";

describe("installFileEditorDismissal", () => {
  it("keeps a text selection made outside the file while its search is open", async () => {
    let editor: Editor<"file" | "file-diff", undefined, undefined> | undefined;
    const createEditor: EditorFactory<undefined, undefined> = (...args) =>
      (editor = new Editor(...args));
    // File paints nothing until the shared highlighter has loaded; once it has, mount renders synchronously.
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    await using screen = await render(
      <>
        <p>Assistant reply</p>
        <div data-testid="file-surface">
          <EditProvider createEditor={createEditor}>
            <File file={{ name: "server.ts", contents: "const server = 1;\n" }} edit />
          </EditProvider>
        </div>
      </>,
    );
    const shadowRoot = () => screen.container.querySelector("diffs-container")?.shadowRoot;
    const content = shadowRoot()?.querySelector<HTMLElement>("[data-content]");
    expect(content).toBeTruthy();

    editor!.setSelections([
      { start: { line: 0, character: 8 }, end: { line: 0, character: 8 }, direction: "none" },
    ]);
    const isMac = isMacPlatform(navigator.platform);
    content!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        code: "KeyF",
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() => expect(CSS.highlights.get("diffs-search-current")?.size).toBe(1));

    using _dismissal = {
      [Symbol.dispose]: installFileEditorDismissal({
        root: screen.getByTestId("file-surface").element() as HTMLElement,
        editor: editor!,
        isBlocked: () => false,
        onDismiss: () => {},
      }),
    };
    const reply = screen.getByText("Assistant reply").element();
    const range = document.createRange();
    range.selectNodeContents(reply);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    reply.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));

    expect(window.getSelection()?.toString()).toBe("Assistant reply");
  });

  it("lets clicks beside the open search panel reach the file's code", async () => {
    let editor: Editor<"file" | "file-diff", undefined, undefined> | undefined;
    const createEditor: EditorFactory<undefined, undefined> = (...args) =>
      (editor = new Editor(...args));
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    const contents = Array.from(
      { length: 12 },
      (_, index) => `const server${index} = "a line long enough to run under the find bar";\n`,
    ).join("");
    await using screen = await render(
      <div style={{ width: 600 }}>
        <EditProvider createEditor={createEditor}>
          <File file={{ name: "server.ts", contents }} edit />
        </EditProvider>
      </div>,
    );
    const shadowRoot = screen.container.querySelector("diffs-container")?.shadowRoot;
    const content = shadowRoot?.querySelector<HTMLElement>("[data-content]");
    expect(content).toBeTruthy();

    editor!.setSelections([
      { start: { line: 0, character: 8 }, end: { line: 0, character: 8 }, direction: "none" },
    ]);
    const isMac = isMacPlatform(navigator.platform);
    content!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        code: "KeyF",
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    const widget = await vi.waitFor(() => {
      const panelHost = [...shadowRoot!.querySelectorAll("*")].find((element) =>
        element.shadowRoot?.querySelector("[data-search-panel]"),
      );
      const found = panelHost?.shadowRoot?.querySelector("[data-editor-widget]");
      expect(found).toBeTruthy();
      return found!;
    });
    const widgetBox = widget.getBoundingClientRect();
    const beside = shadowRoot!.elementFromPoint(
      widgetBox.left - 100,
      widgetBox.top + widgetBox.height / 2,
    );

    expect(content!.contains(beside)).toBe(true);
  });
});
