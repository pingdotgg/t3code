import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import { ProjectGroupingPrompt } from "./ProjectGroupingPrompt";

describe("ProjectGroupingPrompt", () => {
  it("stacks both actions with the description instead of the alert action column", () => {
    const primaryEnvironmentId = EnvironmentId.make("laptop");
    const project = (environmentId: EnvironmentId, id: string): Project => ({
      id: ProjectId.make(id),
      environmentId,
      title: "t3code",
      workspaceRoot: `C:/${id}/t3code`,
      repositoryIdentity: {
        canonicalKey: "github.com/pingdotgg/t3code",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
        },
      },
      defaultModelSelection: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      scripts: [],
    });
    const [group] = buildSidebarProjectSnapshots({
      projects: [
        project(primaryEnvironmentId, "project-laptop"),
        project(EnvironmentId.make("mini-pc"), "project-mini-pc"),
      ],
      settings: {
        sidebarProjectGroupingMode: "repository",
        sidebarProjectGroupingOverrides: {},
      },
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === primaryEnvironmentId ? "Laptop" : "Mini PC",
    });

    const markup = renderToStaticMarkup(
      <ProjectGroupingPrompt
        group={group!}
        onGroup={() => undefined}
        onKeepSeparate={() => undefined}
      />,
    );

    expect(markup).toContain("Keep separate");
    expect(markup).toContain("Group projects");
    expect(markup).not.toContain('data-slot="alert-action"');
  });
});
