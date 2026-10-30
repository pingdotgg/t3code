import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId } from "@t3tools/contracts";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import type { PullRequestEnvironmentTarget } from "./pullRequestEnvironmentFallback";

const mocks = vi.hoisted(() => ({
  environments: [] as ReadonlyArray<WorkspaceEnvironment>,
  isReady: true,
  projects: [] as ReadonlyArray<EnvironmentProject>,
  navigation: { setParams: vi.fn<(params: Partial<PullRequestEnvironmentTarget>) => void>() },
}));

vi.mock("@react-navigation/native", () => ({ useNavigation: () => mocks.navigation }));
vi.mock("../../state/entities", () => ({ useProjects: () => mocks.projects }));
vi.mock("../../state/workspace", () => ({
  useWorkspaceEnvironments: () => mocks.environments,
  useConnectionsReady: () => mocks.isReady,
}));

import { usePullRequestEnvironmentFallback } from "./usePullRequestEnvironmentFallback";

function environment(
  environmentId: string,
  connectionState: EnvironmentConnectionPhase,
  isEnabled = true,
): WorkspaceEnvironment {
  return {
    environmentId: EnvironmentId.make(environmentId),
    environmentLabel: environmentId,
    displayUrl: "",
    isRelayManaged: false,
    isEnabled,
    connectionState,
    connectionError: null,
    connectionErrorTraceId: null,
  };
}

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.isReady = true;
  mocks.environments = [environment("requested", "connecting"), environment("copy", "connected")];
  mocks.projects = [
    { environmentId: "requested", id: "original" },
    { environmentId: "copy", id: "copy-project" },
  ].map(
    (project) =>
      ({
        ...project,
        repositoryIdentity: { canonicalKey: "github.com/owner/repo" },
      }) as unknown as EnvironmentProject,
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  mocks.navigation.setParams = vi.fn();
  function Probe() {
    const [params, updateParams] = useState({
      environmentId: "requested",
      projectId: "original",
      repository: "owner/repo",
      host: "github.com",
    });
    useEffect(() => {
      mocks.navigation.setParams.mockImplementation((next) =>
        updateParams((previous) => ({ ...previous, ...next })),
      );
    }, []);
    usePullRequestEnvironmentFallback(params);
    return <span>{`${params.environmentId}/${params.projectId}`}</span>;
  }
  return {
    render() {
      act(() => root.render(<Probe />));
    },
    get target() {
      return container.textContent;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("keeps the requested target while the catalog initializes or its enabled connection is pending", () => {
  using screen = setup();
  mocks.isReady = false;
  mocks.environments = [environment("copy", "connected")];
  screen.render();
  expect(screen.target).toBe("requested/original");
  expect(mocks.navigation.setParams).not.toHaveBeenCalled();

  mocks.isReady = true;
  for (const phase of ["available", "connecting", "reconnecting", "connected"] as const) {
    mocks.environments = [environment("requested", phase), environment("copy", "connected")];
    screen.render();
    expect(screen.target).toBe("requested/original");
    expect(mocks.navigation.setParams).not.toHaveBeenCalled();
  }
});

it("falls back to a connected repository copy when the requested environment cannot connect", () => {
  for (const state of ["missing", "disabled", "offline", "error", "unsupported"] as const) {
    using screen = setup();
    mocks.environments = [
      ...(state === "missing"
        ? []
        : [
            environment(
              "requested",
              state === "disabled" ? "available" : state,
              state !== "disabled",
            ),
          ]),
      environment("copy", "connected"),
    ];
    screen.render();
    expect(screen.target).toBe("copy/copy-project");
    expect(mocks.navigation.setParams).toHaveBeenCalledExactlyOnceWith({
      environmentId: "copy",
      projectId: "copy-project",
    });
  }
});

it("does not replace a connecting target with a connected repository copy before its project hydrates", () => {
  using screen = setup();
  const projects = mocks.projects;
  mocks.projects = projects.filter((project) => project.environmentId !== "requested");
  screen.render();
  expect(screen.target).toBe("requested/original");
  expect(mocks.navigation.setParams).not.toHaveBeenCalled();

  mocks.projects = projects;
  mocks.environments = [environment("requested", "connected"), environment("copy", "connected")];
  screen.render();
  expect(screen.target).toBe("requested/original");
  expect(mocks.navigation.setParams).not.toHaveBeenCalled();
});
