import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  codeViewItems: null as ReadonlyArray<Record<string, unknown>> | null,
  codeViewOptions: null as Record<string, unknown> | null,
}));

vi.mock("@pierre/diffs/react", () => ({
  CodeView: (props: {
    items: ReadonlyArray<Record<string, unknown>>;
    options: Record<string, unknown>;
  }) => {
    testState.codeViewItems = props.items;
    testState.codeViewOptions = props.options;
    return null;
  },
}));

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (selector: (store: Record<string, unknown>) => unknown) =>
    selector({
      addReviewComment: vi.fn(),
      removeReviewComment: vi.fn(),
      getComposerDraft: () => undefined,
    }),
}));

vi.mock("./DiffCommentAnnotation", () => ({
  DiffCommentAnnotation: () => null,
}));

vi.mock("../files/fileCommentAnnotations", () => ({
  nextFileCommentId: () => "comment-test",
}));

import { getRenderablePatch } from "~/lib/diffRendering";
import { AnnotatableCodeView } from "./AnnotatableCodeView";

describe("AnnotatableCodeView", () => {
  beforeEach(() => {
    testState.codeViewItems = null;
    testState.codeViewOptions = null;
  });

  it("versions same-path files by render content without changing their identity", () => {
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
    ].join("\n");
    const firstPatch = getRenderablePatch(patch, "first");
    const secondPatch = getRenderablePatch(patch, "second");
    if (firstPatch?.kind !== "files" || secondPatch?.kind !== "files") {
      throw new Error("Expected a renderable file patch.");
    }
    const render = (fileDiff: (typeof firstPatch.files)[number]) =>
      renderToStaticMarkup(
        <AnnotatableCodeView
          codeViewKey="test-view"
          files={[
            {
              fileDiff,
              filePath: "src/example.ts",
              fileKey: "src/example.ts",
              collapsed: false,
            },
          ]}
          sectionId="working-tree"
          sectionTitle="Working tree"
          composerDraftTarget={"draft-test" as never}
          options={{}}
          renderHeaderPrefix={() => null}
        />,
      );

    render(firstPatch.files[0]!);
    const firstItem = testState.codeViewItems?.[0];
    render(secondPatch.files[0]!);
    const secondItem = testState.codeViewItems?.[0];

    expect(firstItem?.id).toBe("src/example.ts");
    expect(secondItem?.id).toBe("src/example.ts");
    expect(secondItem?.version).not.toBe(firstItem?.version);
  });

  it("opens comments from Pierre's gutter action without ending line selection", () => {
    renderToStaticMarkup(
      <AnnotatableCodeView
        codeViewKey="test-view"
        files={[]}
        sectionId="working-tree"
        sectionTitle="Working tree"
        composerDraftTarget={"draft-test" as never}
        options={{}}
        renderHeaderPrefix={() => null}
      />,
    );

    expect(testState.codeViewOptions).toMatchObject({
      enableGutterUtility: true,
      enableLineSelection: true,
      onGutterUtilityClick: expect.any(Function),
    });
    expect(testState.codeViewOptions).not.toHaveProperty("onLineSelectionEnd");
  });
});
