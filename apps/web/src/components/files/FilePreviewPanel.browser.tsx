import "../../index.css";

import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/editor";
import { EditorProvider, File } from "@pierre/diffs/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { installFileEditorDismissal } from "./fileEditorDismissal";

interface AnnotationMetadata {
  label: string;
}

function dispatchPointer(target: EventTarget, type: string, pointerId: number): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId,
      pointerType: "mouse",
    }),
  );
}

function EditableAnnotatedFile() {
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
  const [lineAnnotations, setLineAnnotations] = useState<LineAnnotation<AnnotationMetadata>[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const editor = useMemo(() => new Editor<AnnotationMetadata>(), []);

  useEffect(() => () => editor.cleanUp(), [editor]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => false,
      onDismiss: () => setSelectedLines(null),
    });
  }, [editor]);

  return (
    <>
      <div ref={rootRef}>
        <EditorProvider editor={editor}>
          <File<AnnotationMetadata>
            file={{ name: "example.ts", contents: "one\ntwo\nthree\n" }}
            options={{
              disableFileHeader: true,
              enableGutterUtility: true,
              enableLineSelection: true,
              onGutterUtilityClick: setSelectedLines,
              onLineSelectionChange: setSelectedLines,
              onLineSelectionEnd: (range) => {
                setSelectedLines(range);
                if (range) {
                  setLineAnnotations([
                    {
                      lineNumber: Math.max(range.start, range.end),
                      metadata: { label: `${range.start}:${range.end}` },
                    },
                  ]);
                }
              },
            }}
            selectedLines={selectedLines}
            lineAnnotations={lineAnnotations}
            renderAnnotation={(annotation) => (
              <div data-test-file-annotation contentEditable={false}>
                {annotation.metadata.label}
              </div>
            )}
            disableWorkerPool
            contentEditable
          />
        </EditorProvider>
      </div>
      <button type="button">Outside file</button>
    </>
  );
}

async function getEditableFile() {
  const file = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>("diffs-container");
    expect(element?.shadowRoot).not.toBeNull();
    return element!;
  });
  const content = await vi.waitFor(() => {
    const element = file?.shadowRoot?.querySelector<HTMLElement>("[data-content]") ?? null;
    expect(element).not.toBeNull();
    return element!;
  });
  return { file, content };
}

describe("editable Pierre file annotations", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps gutter selection and annotations enabled while the file is editable", async () => {
    const screen = await render(<EditableAnnotatedFile />);

    try {
      const { file, content } = await getEditableFile();
      const secondLineNumber = await vi.waitFor(() => {
        const element =
          file?.shadowRoot?.querySelector<HTMLElement>('[data-column-number="2"]') ?? null;
        expect(element).not.toBeNull();
        return element;
      });
      await vi.waitFor(() => {
        expect(
          file?.shadowRoot?.querySelector("pre")?.hasAttribute("data-interactive-line-numbers"),
        ).toBe(true);
      });

      dispatchPointer(secondLineNumber!, "pointerdown", 1);
      dispatchPointer(secondLineNumber!, "pointerup", 1);

      await vi.waitFor(() => {
        expect(document.querySelector("[data-test-file-annotation]")?.textContent).toBe("2:2");
      });

      expect(content.contentEditable).toBe("true");
      expect(content.getAttribute("role")).toBe("textbox");
    } finally {
      await screen.unmount();
    }
  });

  it("dismisses editor focus and selection with outside click or Escape", async () => {
    const screen = await render(<EditableAnnotatedFile />);

    try {
      const { file, content } = await getEditableFile();
      content.focus();
      expect(file?.shadowRoot?.activeElement).toBe(content);

      await page.getByRole("button", { name: "Outside file" }).click();
      await vi.waitFor(() => {
        expect(file?.shadowRoot?.activeElement).not.toBe(content);
      });

      content.focus();
      expect(file?.shadowRoot?.activeElement).toBe(content);
      content.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      await vi.waitFor(() => {
        expect(file?.shadowRoot?.activeElement).not.toBe(content);
      });
    } finally {
      await screen.unmount();
    }
  });
});
