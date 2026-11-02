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
function Harness({ draftId }: { readonly draftId: DraftId }) {
  const draftThread = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const routing = useDraftEnvironmentRouting({
    draftId,
    draftThread,
    envLocked: false,
    automaticEnvironment: draftThread?.environmentSelection !== "manual",
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
    <>
      <p>{routing.isEnvironmentChanging ? "Preparing machine" : "Ready"}</p>
      <button type="button" onClick={routing.onAutoEnvironmentStable}>
        Auto balance
      </button>
      <button type="button" onClick={() => routing.onEnvironmentChangeStable(machineA)}>
        Use machine A
      </button>
    </>
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

function setup(name: string, balancedEnvironmentId: EnvironmentId) {
  balancer.setup(balancedEnvironmentId);
  scratchOpens.setup();
  const draftId = DraftId.make(name);
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(
      "scratch-local",
      scopeProjectRef(local, ProjectId.make("scratch-local")),
      draftId,
      { environmentSelection: "auto" },
    );
  return {
    draftId,
    draft: () => useComposerDraftStore.getState().getDraftSession(draftId),
    opened: () => scratchOpens.opens.map((open) => open.environmentId),
  };
}

describe("useDraftEnvironmentRouting", () => {
  it("opens the balanced machine's scratch project before moving a scratch draft there", async () => {
    const { draftId, draft, opened } = setup("draft-auto-scratch", machineB);
    await using screen = await render(<Harness draftId={draftId} />);

    await expect.element(screen.getByText("Preparing machine")).toBeInTheDocument();
    expect(opened()).toEqual([machineB]);
    expect(draft()?.environmentId).toBe(local);

    await act(() => scratchOpens.opens[0]!.resolve(scratchProject(machineB)));
    await expect.element(screen.getByText("Ready")).toBeInTheDocument();
    expect(draft()).toMatchObject({
      environmentId: machineB,
      projectId: `scratch-${machineB}`,
      environmentSelection: "auto",
      loadBalancedEnvironmentId: machineB,
    });
  });

  it("keeps the draft in place when the open fails or a newer pick supersedes it", async () => {
    const { draftId, draft, opened } = setup("draft-auto-superseded", machineA);
    await using screen = await render(<Harness draftId={draftId} />);
    await expect.element(screen.getByText("Preparing machine")).toBeInTheDocument();

    await act(() => balancer.set(machineB));
    expect(opened()).toEqual([machineA, machineB]);
    await act(() => scratchOpens.opens[1]!.resolve(null));
    await act(() => scratchOpens.opens[0]!.resolve(scratchProject(machineA)));

    await expect.element(screen.getByText("Ready")).toBeInTheDocument();
    expect(draft()?.environmentId).toBe(local);
    expect(draft()?.loadBalancedEnvironmentId).toBeFalsy();

    // Re-arming Auto retries the failed open.
    await userEvent.click(screen.getByRole("button", { name: "Auto balance" }));
    expect(opened()).toEqual([machineA, machineB, machineB]);
    await expect.element(screen.getByText("Preparing machine")).toBeInTheDocument();
  });

  it("lets a manual machine pick made during an Auto open win", async () => {
    const { draftId, draft, opened } = setup("draft-auto-manual", machineB);
    await using screen = await render(<Harness draftId={draftId} />);
    await expect.element(screen.getByText("Preparing machine")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Use machine A" }));
    expect(opened()).toEqual([machineB, machineA]);
    await act(() => scratchOpens.opens[1]!.resolve(scratchProject(machineA)));
    await act(() => scratchOpens.opens[0]!.resolve(scratchProject(machineB)));

    await expect.element(screen.getByText("Ready")).toBeInTheDocument();
    expect(draft()).toMatchObject({
      environmentId: machineA,
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
    });
  });
});
