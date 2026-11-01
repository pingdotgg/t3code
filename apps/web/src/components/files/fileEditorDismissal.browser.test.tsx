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
    const content = await vi.waitFor(() => {
      const element = shadowRoot()?.querySelector<HTMLElement>("[data-content]");
      expect(element).toBeTruthy();
      return element!;
    });

    editor!.setSelections([
      { start: { line: 0, character: 8 }, end: { line: 0, character: 8 }, direction: "none" },
    ]);
    const isMac = isMacPlatform(navigator.platform);
    content.dispatchEvent(
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
    await vi.waitFor(() =>
      expect(shadowRoot()?.querySelectorAll("[data-match-range]")).toHaveLength(1),
    );

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
});
