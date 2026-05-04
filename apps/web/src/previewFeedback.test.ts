import { describe, expect, it } from "vitest";

import {
  buildPreviewFeedbackPrompt,
  buildPreviewFeedbackScopeKey,
  filterAnnotationsForActiveScope,
  markPreviewFeedbackAnnotationsSent,
  stableHashPreviewArgs,
  type PreviewFeedbackAnnotation,
  type PreviewFeedbackScope,
} from "./previewFeedback";

const scope: PreviewFeedbackScope = {
  scenarioId: "default",
  scenarioName: "Default",
  argOverrides: { label: "Save", nested: { count: 1 } },
  argOverridesHash: stableHashPreviewArgs({ nested: { count: 1 }, label: "Save" }),
  viewport: { id: "desktop", width: 1280, height: 800 },
};

function annotation(
  id: string,
  input?: Partial<PreviewFeedbackAnnotation>,
): PreviewFeedbackAnnotation {
  return {
    id,
    previewFileRelativePath: "src/Button.preview.tsx",
    componentRelativePath: "src/Button.tsx",
    runtimeInstanceId: "runtime-1",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
    sentAt: null,
    status: "unsent",
    comment: "Make this button primary.",
    scope,
    target: {
      kind: "text",
      element: '<Button> button "Save"',
      elementPath: ".toolbar > button",
      fullPath: "html > body > div > button",
      cssClasses: "btn, secondary",
      computedStyles: "font-size: 13px",
      computedStyleMap: { fontSize: "13px" },
      accessibility: "role: button",
      nearbyText: "Save Cancel",
      nearbyElements: 'button "Cancel"',
      reactComponents: "<Toolbar> <Button>",
      sourceFile: "src/Button.tsx:12",
      boundingBox: { x: 10, y: 20, width: 100, height: 32 },
      marker: { xPercent: 12, yDocument: 42, isFixed: false },
      selectedText: "Save",
    },
    ...input,
  };
}

describe("previewFeedback", () => {
  it("hashes control args deterministically", () => {
    expect(stableHashPreviewArgs({ b: 2, a: 1 })).toBe(stableHashPreviewArgs({ a: 1, b: 2 }));
  });

  it("changes scope key when scenario or controls change", () => {
    expect(buildPreviewFeedbackScopeKey(scope)).not.toBe(
      buildPreviewFeedbackScopeKey({ ...scope, scenarioId: "empty" }),
    );
    expect(buildPreviewFeedbackScopeKey(scope)).not.toBe(
      buildPreviewFeedbackScopeKey({ ...scope, argOverridesHash: stableHashPreviewArgs({}) }),
    );
  });

  it("filters annotations to the active scope", () => {
    const otherScope = { ...scope, scenarioId: "empty" };
    expect(
      filterAnnotationsForActiveScope(
        [annotation("a"), annotation("b", { scope: otherScope })],
        scope,
      ).map((entry) => entry.id),
    ).toEqual(["a"]);
  });

  it("marks selected annotations sent without changing unrelated annotations", () => {
    const result = markPreviewFeedbackAnnotationsSent(
      [annotation("a"), annotation("b")],
      ["b"],
      "2026-05-04T01:00:00.000Z",
    );
    expect(result[0]?.status).toBe("unsent");
    expect(result[1]?.status).toBe("sent");
    expect(result[1]?.sentAt).toBe("2026-05-04T01:00:00.000Z");
  });

  it("builds a structured feedback prompt with target metadata", () => {
    const prompt = buildPreviewFeedbackPrompt({
      previewFileRelativePath: "src/Button.preview.tsx",
      componentRelativePath: "src/Button.tsx",
      scope,
      annotations: [annotation("a")],
    });
    expect(prompt).toContain("# Preview feedback");
    expect(prompt).toContain("Preview file: src/Button.preview.tsx");
    expect(prompt).toContain("Component file: src/Button.tsx");
    expect(prompt).toContain("Relevant files:");
    expect(prompt).toContain("- src/Button.preview.tsx");
    expect(prompt).toContain("- src/Button.tsx");
    expect(prompt).toContain("- src/Button.tsx:12");
    expect(prompt).toContain("Scenario: Default");
    expect(prompt).toContain("Source: src/Button.tsx:12");
    expect(prompt).toContain("React: <Toolbar> <Button>");
    expect(prompt).toContain('Selected text: "Save"');
    expect(prompt).toContain("Make this button primary.");
  });
});
