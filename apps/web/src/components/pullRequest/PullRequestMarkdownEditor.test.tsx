import type { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SourceControlMarkdownEditor } from "./PullRequestMarkdownEditor";

describe("SourceControlMarkdownEditor", () => {
  it("uses the shared named toggle group for markdown views", () => {
    const markup = renderToStaticMarkup(
      <SourceControlMarkdownEditor
        value="Body"
        cwd="/tmp/project"
        environmentId={"environment-1" as EnvironmentId}
        label="Edit body"
        saving={false}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(markup).toContain('data-slot="toggle-group"');
    expect(markup).toContain('aria-label="Markdown view"');
    expect(markup).toContain(">Write<");
    expect(markup).toContain(">Preview<");
  });
});
