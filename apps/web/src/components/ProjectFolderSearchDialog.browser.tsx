import "../index.css";

import { EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProjectFolderSearchDialog } from "./ProjectFolderSearchDialog";
import type { Project } from "../types";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function makeProject(id: string, name: string, cwd: string): Project {
  return {
    id: id as ProjectId,
    environmentId: ENVIRONMENT_ID,
    name,
    cwd,
    defaultModelSelection: null,
    scripts: [],
  };
}

async function mountDialog() {
  const onOpenChange = vi.fn();
  const onSelectProject = vi.fn(async () => undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ProjectFolderSearchDialog
      open={true}
      focusRequestId={1}
      projects={[
        makeProject("project-1", "Clay Server", "/repo/server"),
        makeProject("project-2", "Clay Desktop", "/repo/desktop"),
      ]}
      onOpenChange={onOpenChange}
      onSelectProject={onSelectProject}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    onOpenChange,
    onSelectProject,
  };
}

describe("ProjectFolderSearchDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("filters projects and opens the highlighted result", async () => {
    await using mounted = await mountDialog();

    await page.getByTestId("project-folder-search-input").fill("desk");
    await page.getByRole("button", { name: /Clay Desktop/i }).click();

    expect(mounted.onOpenChange).toHaveBeenCalledWith(false);
    expect(mounted.onSelectProject).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: ENVIRONMENT_ID, projectId: "project-2" }),
    );
  });
});
