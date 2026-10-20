import type { CodeViewDiffItem, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { act, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileDiffIdentityKey } from "~/lib/diffRendering";

type ViewerProps = Omit<ComponentProps<typeof StyledDiffCodeView<unknown>>, "options"> & {
  options: {
    enableLineSelection: boolean;
    enableGutterUtility: boolean;
    onGutterUtilityClick: (
      range: SelectedLineRange,
      context: { item: CodeViewDiffItem<unknown> },
    ) => void;
  };
};

// Replace only the virtualized viewer; comment editing and submission use the real components.
vi.mock("./StyledDiffCodeView", () => ({
  StyledDiffCodeView: (props: ViewerProps) =>
    props.items
      ?.filter((item) => item.type === "diff")
      .map((item) => (
        <section key={item.id}>
          <button
            disabled={!props.options?.enableLineSelection || !props.options?.enableGutterUtility}
            onClick={() => {
              props.onSelectedLinesChange?.({ id: item.id, range });
              props.options?.onGutterUtilityClick?.(range, { item });
            }}
          >
            Comment on {item.fileDiff.name}
          </button>
          {props.selectedLines?.id === item.id ? (
            <mark>Line {props.selectedLines.range.start}</mark>
          ) : null}
          {item.annotations?.map((annotation) => (
            <div key={`${annotation.side}:${annotation.lineNumber}`}>
              {props.renderAnnotation?.(annotation, item)}
            </div>
          ))}
        </section>
      )),
}));

import { AnnotatableCodeView } from "./AnnotatableCodeView";
import type { StyledDiffCodeView } from "./StyledDiffCodeView";

const target = DraftId.make("diff-draft-test");
const range: SelectedLineRange = { start: 1, end: 1, side: "additions" };
let root: Root;
let container: HTMLDivElement;

function file(
  name: string,
  fileVersion = 1,
  type: FileDiffMetadata["type"] = "change",
  prevName?: string,
) {
  const fileDiff = parsePatchFiles(
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`,
    name,
  )[0]!.files[0]!;
  fileDiff.type = type;
  if (prevName) fileDiff.prevName = prevName;
  return {
    fileDiff,
    filePath: name,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion,
    collapsed: false,
  };
}

function render(
  files: ReturnType<typeof file>[],
  codeViewKey = "initial",
  pendingFiles: FileDiffMetadata[] = [],
) {
  act(() =>
    root.render(
      <StrictMode>
        <AnnotatableCodeView
          codeViewKey={codeViewKey}
          files={files}
          pendingFiles={pendingFiles}
          sectionId="unstaged"
          sectionTitle="Uncommitted"
          composerDraftTarget={target}
          options={{}}
          renderHeaderFilenameSuffix={() => null}
          renderHeaderPrefix={() => null}
          onRevealSearchMatch={() => {}}
        />
      </StrictMode>,
    ),
  );
}

function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  act(() => button.click());
}

function editor() {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Comment editor is not available");
  return textarea;
}

function typeComment(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      editor(),
      text,
    );
    editor().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  vi.unstubAllGlobals();
});

describe("diff comment drafts", () => {
  it.each(["removed file", "replaced rename"] as const)(
    "allows a fresh comment after a %s loses its draft",
    (scenario) => {
      const original =
        scenario === "removed file"
          ? file("a.ts")
          : file("shared.ts", 1, "rename-changed", "old.ts");
      render([original, file("b.ts")]);
      click(`Comment on ${original.filePath}`);
      typeComment("Discard this draft");
      const pending =
        scenario === "removed file"
          ? []
          : [
              {
                ...file("shared.ts", 2, "rename-changed", "other.ts").fileDiff,
                hunks: [],
                cacheKey: "replacement:pending",
              },
            ];

      render([file("b.ts")], "refreshed", pending);
      expect(container.querySelector("textarea")).toBeNull();
      click("Comment on b.ts");
      expect(editor().value).toBe("");
      typeComment("  Review b.ts  ");
      click("Comment");

      expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments).toEqual([
        expect.objectContaining({
          filePath: "b.ts",
          text: "Review b.ts",
          selection: { ...range, endSide: "additions" },
        }),
      ]);
      render([original, file("b.ts")], "returned");
      expect(container.querySelector("textarea")).toBeNull();
      expect(container.querySelector("mark")).toBeNull();
      expect(container.querySelector("p")?.textContent).toBe("Review b.ts");
    },
  );

  it("keeps the text and selected line through refresh and a provisional lazy patch", () => {
    const original = file("shared.ts", 1, "rename-pure", "old.ts");
    render([original]);
    click("Comment on shared.ts");
    typeComment("Keep this draft");
    const refreshed = file("shared.ts", 2, "rename-pure", "old.ts");
    render([refreshed], "refreshed");
    expect(editor().value).toBe("Keep this draft");
    expect(container.querySelector("mark")?.textContent).toBe("Line 1");

    render([], "loading", [
      { ...refreshed.fileDiff, type: "rename-changed", hunks: [], cacheKey: "shared:pending" },
    ]);
    expect(container.querySelector("textarea")).toBeNull();
    render([refreshed], "loaded");
    expect(editor().value).toBe("Keep this draft");
    expect(container.querySelector("mark")?.textContent).toBe("Line 1");
    click("Comment");
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments).toEqual([
      expect.objectContaining({
        filePath: "shared.ts",
        text: "Keep this draft",
        selection: { ...range, endSide: "additions" },
      }),
    ]);
    expect(container.querySelector("p")?.textContent).toBe("Keep this draft");
  });
});
