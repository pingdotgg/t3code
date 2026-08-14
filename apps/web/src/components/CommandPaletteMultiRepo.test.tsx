import { EnvironmentId, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { MultiRepoProjectForm, type MultiRepoProjectDraft } from "./CommandPaletteMultiRepo";

const noop = vi.fn();

function renderForm(draft: MultiRepoProjectDraft) {
  return renderToStaticMarkup(
    <MultiRepoProjectForm
      draft={draft}
      environmentLabel="This machine"
      isCreating={false}
      onAddRepository={noop}
      onCancel={noop}
      onCreate={noop}
      onMakePrimary={noop}
      onRemoveRoot={noop}
      onTitleChange={noop}
    />,
  );
}

describe("MultiRepoProjectForm", () => {
  it("teaches the empty source-folder flow and keeps creation disabled", () => {
    const markup = renderForm({
      token: 1,
      environmentId: EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID),
      roots: [],
      stage: "form",
      title: "",
      titleSource: "automatic",
    });

    expect(markup).toContain("Create project");
    expect(markup).toContain("Source folders");
    expect(markup).toContain("Add folders");
    expect(markup).toContain("Add at least two Git repositories");
    expect(markup).toMatch(/disabled=""[^>]*>Create project/);
  });

  it("shows primary controls and enables a named two-repository project", () => {
    const markup = renderForm({
      token: 2,
      environmentId: EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID),
      roots: ["/work/docs", "/work/scripts"],
      stage: "form",
      title: "Developer tools",
      titleSource: "user",
    });

    expect(markup).toContain("Developer tools");
    expect(markup).toContain("docs");
    expect(markup).toContain("scripts");
    expect(markup).toContain("Primary");
    expect(markup).toContain("Make primary");
    expect(markup).toContain("Add folder");
    expect(markup).not.toMatch(/disabled=""[^>]*>Create project/);
  });
});
