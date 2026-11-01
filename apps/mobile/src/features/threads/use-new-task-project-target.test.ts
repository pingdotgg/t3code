import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => projects,
  useServerConfigs: () => configs,
}));
vi.mock("../../state/project-grouping", () => ({
  useMobileProjectGroupingSettings: () => ({
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [mac, pad].map((environmentId) => ({
      environmentId,
      connectionState: "connected",
    })),
  }),
}));

import { useNewTaskProjectTarget } from "./use-new-task-project-target";

const mac = EnvironmentId.make("mac");
const pad = EnvironmentId.make("pad");
function makeProject(environmentId: EnvironmentId) {
  return {
    environmentId,
    id: ProjectId.make(`${environmentId}-project`),
    title: "repo",
    workspaceRoot: "/projects/repo",
    repositoryIdentity: {
      canonicalKey: "repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://example.com/repo.git",
      },
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } satisfies EnvironmentProject;
}
const macProject = makeProject(mac);
const padProject = makeProject(pad);
const projects = [macProject, padProject];
const configs = new Map([
  [
    mac,
    { settings: { projectSettingsOverrides: { [macProject.id]: { defaultEnvironmentId: pad } } } },
  ],
  [pad, { settings: { projectSettingsOverrides: {} } }],
]);

describe("mobile project picker targets", () => {
  it("preserves the manually selected copy when reselecting its logical project", () => {
    expect(
      useNewTaskProjectTarget()(padProject, {
        manualProjectRef: scopeProjectRef(mac, macProject.id),
      }),
    ).toBe(macProject);
  });
});
