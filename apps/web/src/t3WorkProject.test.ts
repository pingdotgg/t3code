import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isT3WorkBackingProject, t3WorkDirectoryForEnvironment } from "./t3WorkProject";

const environmentId = EnvironmentId.make("environment:local");
const serverConfigs = new Map([
  [
    environmentId,
    {
      t3WorkDirectory: "/private/t3-work",
    } as ServerConfig,
  ],
]);

function project(workspaceRoot: string): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(`project:${workspaceRoot}`),
    title: "Project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}

describe("T3 Work backing project", () => {
  it("resolves the private conversation directory for an environment", () => {
    expect(t3WorkDirectoryForEnvironment(serverConfigs, environmentId)).toBe("/private/t3-work");
    expect(t3WorkDirectoryForEnvironment(serverConfigs, null)).toBeNull();
  });

  it("hides only the project whose root is the private conversation directory", () => {
    expect(isT3WorkBackingProject(project("/private/t3-work"), serverConfigs)).toBe(true);
    expect(isT3WorkBackingProject(project("/workspace/repo"), serverConfigs)).toBe(false);
  });
});
