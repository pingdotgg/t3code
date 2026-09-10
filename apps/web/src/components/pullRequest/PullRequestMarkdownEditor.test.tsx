import type { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";

describe("PullRequestMarkdownEditor", () => {
  it("uses the shared named toggle group for markdown views", () => {
    const markup = renderToStaticMarkup(
      <PullRequestMarkdownEditor
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
    expect(markup).toContain('aria-label="Markdown editor mode"');
    expect(markup).toContain(">Write<");
    expect(markup).toContain(">Preview<");
  });
});
