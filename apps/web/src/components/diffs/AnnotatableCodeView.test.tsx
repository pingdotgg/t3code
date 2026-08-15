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

  it("keeps file identity stable while versioning content and syntax themes", () => {
    const firstPatchText = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
    ].join("\n");
    const secondPatchText = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 2;",
      "+export const value = 3;",
    ].join("\n");
    const firstPatch = getRenderablePatch(firstPatchText, "test");
    const secondPatch = getRenderablePatch(secondPatchText, "test");
    if (firstPatch?.kind !== "files" || secondPatch?.kind !== "files") {
      throw new Error("Expected a renderable file patch.");
    }
    const render = (
      fileDiff: (typeof firstPatch.files)[number],
      syntaxThemeName: "pierre-dark" | "pierre-light" = "pierre-dark",
    ) =>
      renderToStaticMarkup(
        <AnnotatableCodeView
          codeViewKey="test-view"
          syntaxThemeName={syntaxThemeName}
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
    render(secondPatch.files[0]!, "pierre-light");
    const themedItem = testState.codeViewItems?.[0];

    expect(firstItem?.id).toBe("src/example.ts");
    expect(secondItem?.id).toBe("src/example.ts");
    expect(themedItem?.id).toBe("src/example.ts");
    expect(secondItem?.version).not.toBe(firstItem?.version);
    expect(themedItem?.version).not.toBe(secondItem?.version);
  });

  it("opens comments from Pierre's gutter action without ending line selection", () => {
    renderToStaticMarkup(
      <AnnotatableCodeView
        codeViewKey="test-view"
        syntaxThemeName="pierre-dark"
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
