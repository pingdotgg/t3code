import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkflowEditorFullscreen } from "./WorkflowEditorFullscreen";

describe("WorkflowEditorFullscreen", () => {
  it("renders workflow editing as a full-screen surface instead of a side sheet", () => {
    const markup = renderToStaticMarkup(
      <WorkflowEditorFullscreen open onClose={() => {}}>
        <div>Workflow editor content</div>
      </WorkflowEditorFullscreen>,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('data-workflow-editor-surface="fullscreen"');
    expect(markup).toContain("fixed inset-0");
    expect(markup).not.toContain('data-slot="sheet-popup"');
  });

  it("does not render when closed", () => {
    const markup = renderToStaticMarkup(
      <WorkflowEditorFullscreen open={false} onClose={() => {}}>
        <div>Workflow editor content</div>
      </WorkflowEditorFullscreen>,
    );

    expect(markup).toBe("");
  });
});
