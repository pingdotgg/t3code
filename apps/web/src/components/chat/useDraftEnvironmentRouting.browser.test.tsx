import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const balancer = vi.hoisted(() => {
  let environmentId: string | null = null;
  const listeners = new Set<() => void>();
  return {
    setup: (initial: string | null) => {
      environmentId = initial;
      listeners.clear();
    },
    get: () => environmentId,
    set: (next: string | null) => {
      environmentId = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
const scratchOpens = vi.hoisted(() => {
  const opens: Array<{ environmentId: string; resolve: (project: unknown) => void }> = [];
  return {
    setup: () => opens.splice(0),
    opens,
    open: (environmentId: string) =>
      new Promise((resolve) => opens.push({ environmentId, resolve })),
  };
});

vi.mock(import("../../hooks/useLoadBalancedEnvironment"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useLoadBalancedEnvironment: (() => ({
      refresh: () => undefined,
      pending: false,
      environmentId: useSyncExternalStore(balancer.subscribe, balancer.get),
      failed: false,
    })) as never,
  };
});
vi.mock(import("../../hooks/useScratchProject"), async (original) => ({
  ...(await original()),
  useScratchProject: (() => ({ openScratchProject: scratchOpens.open })) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
}));

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";

const local = EnvironmentId.make("environment-local");
const machineA = EnvironmentId.make("environment-a");
const machineB = EnvironmentId.make("environment-b");
const draftId = DraftId.make("draft-scratch");

function Harness() {
  const draftThread = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const routing = useDraftEnvironmentRouting({
    draftId,
    draftThread,
    envLocked: false,
    automaticEnvironment: true,
    logicalProjectEnvironments: [local, machineA, machineB].map((environmentId) => ({
      environmentId,
      projectId: environmentId === local ? ProjectId.make("scratch-local") : null,
      label: environmentId,
      isPrimary: environmentId === local,
    })) as never,
    environmentById: new Map(),
    providersByEnvironment: new Map(),
    loadBalancingSettings: { loadBalancingWeights: {} },
    referencedThreadContexts: [],
    activeProviderInstanceId: null,
    selectedProvider: "codex" as never,
    composerHasAttachments: false,
    activeProjectKey: "scratch-local",
    activeProjectIsScratch: true,
    projectGroupingSettings: {
      sidebarProjectGroupingMode: "repository",
      sidebarProjectGroupingOverrides: {},
    },
    sendInFlightRef: { current: false },
  });
  return (
    <button type="button" onClick={routing.onAutoEnvironmentStable}>
      {routing.isEnvironmentChanging ? "Preparing machine" : "Ready"}
    </button>
  );
}

const scratchProject = (environmentId: EnvironmentId) => ({
  environmentId,
  id: ProjectId.make(`scratch-${environmentId}`),
  title: "No project",
  workspaceRoot: `/scratch/${environmentId}`,
  repositoryIdentity: null,
  isScratch: true,
});

describe("useDraftEnvironmentRouting", () => {
  it("shows Preparing machine only while the current Auto scratch open runs", async () => {
    balancer.setup(machineA);
    scratchOpens.setup();
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(
        "scratch-local",
        scopeProjectRef(local, ProjectId.make("scratch-local")),
        draftId,
        { environmentSelection: "auto" },
      );
    await using screen = await render(<Harness />);
    const opened = () => scratchOpens.opens.map((open) => open.environmentId);
    await expect.element(screen.getByText("Preparing machine")).toBeInTheDocument();

    // A late open for an old pick neither moves the draft nor leaves it preparing.
    await act(() => balancer.set(machineB));
    await act(() => scratchOpens.opens[1]!.resolve(null));
    await act(() => scratchOpens.opens[0]!.resolve(scratchProject(machineA)));
    await expect.element(screen.getByText("Ready")).toBeInTheDocument();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(local);
    expect(opened()).toEqual([machineA, machineB]);

    // Re-arming Auto retries the failed open.
    await userEvent.click(screen.getByRole("button"));
    expect(opened()).toEqual([machineA, machineB, machineB]);
    await act(() => scratchOpens.opens[2]!.resolve(null));

    // Returning to a target whose open failed opens it again, and shows it.
    await act(() => balancer.set(machineA));
    await act(() => scratchOpens.opens[3]!.resolve(null));
    await expect.element(screen.getByText("Ready")).toBeInTheDocument();
    await act(() => balancer.set(machineB));
    await act(() => balancer.set(machineA));
    expect(opened()).toEqual([machineA, machineB, machineB, machineA, machineB, machineA]);
    await expect.element(screen.getByText("Preparing machine")).toBeInTheDocument();
    await act(() => scratchOpens.opens[5]!.resolve(scratchProject(machineA)));
    await expect.element(screen.getByText("Ready")).toBeInTheDocument();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      environmentId: machineA,
      loadBalancedEnvironmentId: machineA,
    });
  });
});
