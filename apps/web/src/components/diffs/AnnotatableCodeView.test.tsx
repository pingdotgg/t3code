import type {
  CodeViewDiffItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { act, StrictMode, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileDiffIdentityKey } from "~/lib/diffRendering";

type Selection = { id: string; range: SelectedLineRange } | null;
interface ViewerProps {
  items: CodeViewDiffItem<unknown>[];
  selectedLines: Selection;
  onSelectedLinesChange: (selection: Selection) => void;
  options: {
    enableLineSelection: boolean;
    enableGutterUtility: boolean;
    onGutterUtilityClick: (
      range: SelectedLineRange,
      context: { item: CodeViewDiffItem<unknown> },
    ) => void;
  };
  renderAnnotation: (annotation: DiffLineAnnotation<unknown>) => ReactNode;
}

vi.mock("./StyledDiffCodeView", () => ({
  StyledDiffCodeView: (props: ViewerProps) =>
    props.items.map((item) => (
      <div key={item.id}>
        {item.annotations?.map((annotation) => (
          <div key={`${annotation.side}:${annotation.lineNumber}`}>
            {props.renderAnnotation(annotation)}
          </div>
        ))}
      </div>
    )),
}));
vi.mock("./DiffCommentAnnotation", () => ({ DiffCommentAnnotation: "diff-comment" }));

import { AnnotatableCodeView } from "./AnnotatableCodeView";
import { DiffCommentAnnotation } from "./DiffCommentAnnotation";
import { StyledDiffCodeView } from "./StyledDiffCodeView";

const target = DraftId.make("diff-draft-test");
const range: SelectedLineRange = { start: 1, end: 1, side: "additions" };
let renderer: ReactTestRenderer;

function file(
  name: string,
  fileVersion = 1,
  type: FileDiffMetadata["type"] = "change",
  previousName?: string,
) {
  const fileDiff = parsePatchFiles(
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+new\n`,
    name,
  )[0]!.files[0]!;
  fileDiff.type = type;
  if (previousName) fileDiff.prevName = previousName;
  return {
    fileDiff,
    filePath: name,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion,
    collapsed: false,
  };
}

function view(
  files: ReturnType<typeof file>[],
  codeViewKey = "scope:initial",
  pendingFiles: FileDiffMetadata[] = [],
) {
  return (
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
    </StrictMode>
  );
}

function viewer(): ViewerProps {
  return renderer.root.findByType(StyledDiffCodeView).props as ViewerProps;
}

function beginComment() {
  const props = viewer();
  act(() => {
    props.onSelectedLinesChange({ id: props.items[0]!.id, range });
    props.options.onGutterUtilityClick(range, { item: props.items[0]! });
  });
  act(() => {
    renderer.root.findByType(DiffCommentAnnotation).props.onTextChange("Keep this draft");
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  act(() => {
    renderer = create(view([file("a.ts"), file("b.ts")]));
  });
});

afterEach(() => {
  act(() => renderer.unmount());
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  vi.unstubAllGlobals();
});

describe("diff comment drafts", () => {
  it("releases a removed file's draft so a surviving file can receive a comment", () => {
    beginComment();
    expect(viewer().options.enableLineSelection).toBe(false);

    act(() => renderer.update(view([file("b.ts")], "scope:refreshed")));

    expect(renderer.root.findAllByType(DiffCommentAnnotation)).toHaveLength(0);
    expect(viewer().selectedLines).toBeNull();
    expect(viewer().options.enableLineSelection).toBe(true);
    expect(viewer().options.enableGutterUtility).toBe(true);
    act(() => {
      viewer().options.onGutterUtilityClick(range, { item: viewer().items[0]! });
    });
    const comment = renderer.root.findByType(DiffCommentAnnotation);
    expect(comment.props.text).toBe("");
    act(() => comment.props.onComment("Review b.ts"));
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments).toEqual([
      expect.objectContaining({ filePath: "b.ts", text: "Review b.ts" }),
    ]);

    act(() => renderer.update(view([file("a.ts"), file("b.ts")])));
    expect(renderer.root.findAllByType(DiffCommentAnnotation)).toHaveLength(1);
    expect(renderer.root.findByType(DiffCommentAnnotation).props.kind).toBe("comment");
  });

  it("preserves draft text and selection when refresh retains the file", () => {
    beginComment();

    act(() => renderer.update(view([file("a.ts", 2)], "scope:refreshed")));

    expect(renderer.root.findByType(DiffCommentAnnotation).props.text).toBe("Keep this draft");
    expect(viewer().selectedLines).toEqual({ id: file("a.ts").fileKey, range });
    expect(viewer().options.enableLineSelection).toBe(false);
    expect(viewer().options.enableGutterUtility).toBe(false);
  });

  it.each(["change", "new", "deleted", "rename-pure", "rename-changed"] as const)(
    "preserves a %s draft while its patch reloads",
    (type) => {
      const previousName = type.startsWith("rename") ? "old.ts" : undefined;
      const original = file("a.ts", 1, type, previousName);
      act(() => renderer.update(view([original, file("b.ts")])));
      beginComment();
      const pending = {
        ...original.fileDiff,
        type: previousName ? ("rename-changed" as const) : ("change" as const),
        hunks: [],
        cacheKey: "scope:a.ts:pending",
      };

      act(() => renderer.update(view([file("b.ts")], "scope:loading", [pending])));
      act(() =>
        renderer.update(view([file("a.ts", 2, type, previousName), file("b.ts")], "scope:loaded")),
      );

      expect(renderer.root.findByType(DiffCommentAnnotation).props.text).toBe("Keep this draft");
      expect(viewer().selectedLines).toEqual({ id: original.fileKey, range });
      expect(viewer().options.enableGutterUtility).toBe(false);
    },
  );

  it("releases a replaced rename's draft when the replacement patch is unavailable", () => {
    const original = file("shared.ts", 1, "rename-changed", "old.ts");
    act(() => renderer.update(view([original, file("b.ts")])));
    beginComment();
    const replacement = file("shared.ts", 2, "rename-changed", "other.ts");
    const pending = { ...replacement.fileDiff, hunks: [], cacheKey: "scope:shared.ts:pending" };

    // Failed lazy queries retain their placeholder metadata in the pending list.
    act(() => renderer.update(view([file("b.ts")], "scope:failed", [pending])));

    expect(renderer.root.findAllByType(DiffCommentAnnotation)).toHaveLength(0);
    expect(viewer().selectedLines).toBeNull();
    expect(viewer().options.enableLineSelection).toBe(true);
    expect(viewer().options.enableGutterUtility).toBe(true);
    act(() => viewer().options.onGutterUtilityClick(range, { item: viewer().items[0]! }));
    expect(renderer.root.findByType(DiffCommentAnnotation).props.text).toBe("");
  });
});
