import { describe, expect, it } from "vitest";

import { buildPreviewRenderUrl, deriveChangedPreviewTabs } from "./previewSupport";

describe("buildPreviewRenderUrl", () => {
  it("includes the preview case, theme, and load token in the render URL", () => {
    expect(
      buildPreviewRenderUrl({
        baseUrl: "http://127.0.0.1:43123",
        previewId: "apps/web/src/components/ui/button.tsx#Button",
        caseId: "default",
        theme: "dark",
        viewportWidth: 1024,
        token: "preview-load-token",
        renderToken: "generated-render-token",
      }),
    ).toBe(
      "http://127.0.0.1:43123/__forma/render/apps%2Fweb%2Fsrc%2Fcomponents%2Fui%2Fbutton.tsx%23Button?case=default&theme=dark&viewportWidth=1024&token=preview-load-token&renderToken=generated-render-token",
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
            id: "apps/web/src/components/ui/button.tsx#Button",
            label: "Button",
            componentPath: "apps/web/src/components/ui/button.tsx",
            exportName: "Button",
            kind: "component",
            propSummary: [],
            sourceHash: "button-source-hash",
            usageHints: [],
            supported: true,
          },
        ],
        workspaceRoot: "/Users/me/project",
      }),
    ).toEqual([
      {
        id: "apps/web/src/components/ui/button.tsx#Button",
        label: "Button",
        componentPath: "apps/web/src/components/ui/button.tsx",
        exportName: "Button",
        kind: "component",
        propSummary: [],
        sourceHash: "button-source-hash",
        usageHints: [],
        supported: true,
      },
    ]);
  });
});
