import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const archiveState = vi.hoisted(() => ({
  error: null as string | null,
  snapshots: [] as ReadonlyArray<ArchivedSnapshotEntry>,
}));

const projectState = vi.hoisted(() => ({
  projects: [] as ReadonlyArray<Record<string, unknown>>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/entities", () => ({
  useProjects: () => projectState.projects,
}));

vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({
    snapshots: archiveState.snapshots,
    error: archiveState.error,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    unarchiveThread: vi.fn(),
    confirmAndDeleteThread: vi.fn(),
  }),
}));

import { ArchivedThreadsPanel } from "./ArchivedThreadsPanel";

const environmentId = EnvironmentId.make("partial-archive-environment");
const projectId = ProjectId.make("partial-archive-project");

function archivedSnapshot(): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: projectId,
        title: "Loaded project",
        workspaceRoot: "C:\\loaded-project",
        defaultModelSelection: null,
        faviconPath: null,
        scripts: [],
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    ],
    threads: [
      {
        id: ThreadId.make("partial-archive-thread"),
        projectId,
        title: "Loaded archived thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
          options: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
        archivedAt: "2026-08-20T00:00:00.000Z",
        settledOverride: null,
        settledAt: null,
        session: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    ],
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function renderPanel(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ArchivedThreadsPanel() as ReactElement<Record<string, unknown>>;
}

describe("ArchivedThreadsPanel environment loading", () => {
  beforeEach(() => {
    hooks.reset();
    archiveState.error = null;
    archiveState.snapshots = [];
    projectState.projects = [];
  });

  it("renders a partial-load error alongside successful archived groups", () => {
    archiveState.error = "Failed to load archived threads.";
    archiveState.snapshots = [{ environmentId, snapshot: archivedSnapshot() }];
    projectState.projects = [{ environmentId }];

    const panel = renderPanel();
    expect(
      visitElements(
        panel,
        (element) => element.props.title === "Could not load all archived threads",
      ),
    ).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.title === "Loaded project"),
    ).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.title === "Loaded archived thread"),
    ).not.toBeNull();
  });
});
