import { describe, expect, it } from "vitest";

import { buildPreviewRenderUrl, deriveChangedPreviewTabs } from "./previewSupport";

describe("buildPreviewRenderUrl", () => {
  it("includes the preview case, theme, and load token in the render URL", () => {
    expect(
      buildPreviewRenderUrl({
        baseUrl: "http://127.0.0.1:43123",
        previewId: "src/components/ui/button.preview.tsx",
        caseId: "default",
        theme: "dark",
        viewportWidth: 1024,
        token: "preview-load-token",
      }),
    ).toBe(
      "http://127.0.0.1:43123/__forma/render/src%2Fcomponents%2Fui%2Fbutton.preview.tsx?case=default&theme=dark&viewportWidth=1024&token=preview-load-token",
    );
  });
});

describe("deriveChangedPreviewTabs", () => {
  it("matches changed component files to colocated preview entries", () => {
    expect(
      deriveChangedPreviewTabs({
        workEntries: [
          {
            id: "work-1",
            createdAt: "2026-04-23T20:00:00.000Z",
            label: "Worker",
            tone: "tool",
            changedFiles: [
              "/Users/me/project/apps/web/src/components/ui/button.tsx",
              "/Users/me/project/apps/web/src/lib/utils.ts",
            ],
          },
        ],
        previewEntries: [
          {
            id: "src/components/ui/button.preview.tsx",
            label: "Button",
            componentPath: "apps/web/src/components/ui/button.tsx",
            previewPath: "apps/web/src/components/ui/button.preview.tsx",
            defaultCaseId: "default",
            cases: [{ id: "default", label: "Default" }],
          },
        ],
        workspaceRoot: "/Users/me/project",
      }),
    ).toEqual([
      {
        id: "src/components/ui/button.preview.tsx",
        label: "Button",
        componentPath: "apps/web/src/components/ui/button.tsx",
        previewPath: "apps/web/src/components/ui/button.preview.tsx",
        defaultCaseId: "default",
        cases: [{ id: "default", label: "Default" }],
      },
    ]);
  });
});
