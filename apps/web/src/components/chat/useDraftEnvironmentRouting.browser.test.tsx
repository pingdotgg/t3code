import { EnvironmentId, ProjectId, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";

const mac = EnvironmentId.make("mac");
const box = EnvironmentId.make("box");
const draftId = "draft-1" as DraftId;
const boxScratch = {
  environmentId: box,
  id: ProjectId.make("scratch-box"),
  workspaceRoot: "/home/me/.t3/scratch",
};

const mocks = vi.hoisted(() => ({
  macScratch: { environmentId: "mac", id: "scratch-mac", workspaceRoot: "/Users/me/.t3/scratch" },
  draft: {} as Record<string, unknown>,
  openScratchProject: vi.fn<(environmentId: string) => Promise<unknown>>(),
  setDraftThreadContext: vi.fn(),
  setLogicalProjectDraftThreadId: vi.fn(),
}));

vi.mock("../../composerDraftStore", () => {
  const store = {
    getDraftSession: () => ({ ...mocks.draft }),
    setDraftThreadContext: mocks.setDraftThreadContext,
    setLogicalProjectDraftThreadId: mocks.setLogicalProjectDraftThreadId,
  };
  return {
    DraftId: {},
    useComposerDraftStore: (selector: (state: typeof store) => unknown) => selector(store),
  };
});
vi.mock("../../hooks/useLoadBalancedEnvironment", () => ({
  useLoadBalancedEnvironment: (candidates: readonly string[]) => ({
    refresh: () => {},
    pending: false,
    environmentId: candidates.includes("box") ? "box" : (candidates[0] ?? null),
    failed: false,
  }),
}));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ openScratchProject: mocks.openScratchProject }),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [mocks.macScratch] }));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveLogicalProjectKeyFromSettings: (project: typeof boxScratch) =>
    `${project.environmentId}:${project.workspaceRoot}`,
}));

function setup(openedProject: typeof boxScratch | null) {
  mocks.openScratchProject.mockReset().mockResolvedValue(openedProject);
  mocks.draft = {
    environmentId: mac,
    projectId: mocks.macScratch.id,
    promotedTo: null,
    loadBalancedEnvironmentId: null,
  };
  const retarget = (context: Record<string, unknown>) => {
    const { projectRef, ...rest } = context as { projectRef?: { environmentId: string } };
    mocks.draft = { ...mocks.draft, ...projectRef, ...rest };
  };
  mocks.setDraftThreadContext.mockReset().mockImplementation((_draftId, context) => {
    retarget(context);
  });
  mocks.setLogicalProjectDraftThreadId
    .mockReset()
    .mockImplementation((_key, projectRef, _draftId, options) => {
      retarget({ projectRef, ...options });
    });
}

const codex = ProviderDriverKind.make("codex");
const provider = {
  instanceId: "codex",
  driver: codex,
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  availability: "available",
};

type Routing = ReturnType<typeof useDraftEnvironmentRouting>;

function ScratchDraft(props: {
  readonly eligible?: boolean;
  readonly referencedEnvironmentId?: EnvironmentId;
  readonly onRouting?: (routing: Routing) => void;
}) {
  const draftThread = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const routing = useDraftEnvironmentRouting({
    draftId,
    draftThread,
    envLocked: false,
    automaticEnvironment:
      (props.eligible ?? true) && draftThread?.environmentSelection !== "manual",
    logicalProjectEnvironments: [mac, box].map((environmentId) => ({
      environmentId,
      projectId: environmentId === mac ? ProjectId.make(mocks.macScratch.id) : null,
      label: environmentId,
      isPrimary: environmentId === mac,
      machine: "desktop" as const,
    })),
    environmentById: new Map(
      [mac, box].map((environmentId) => [
        environmentId,
        { connection: { phase: "connected" }, serverConfig: null } as never,
      ]),
    ),
    providersByEnvironment: new Map([
      [mac, [provider]],
      [box, [provider]],
    ]) as never,
    loadBalancingSettings: { loadBalancingWeights: {} },
    referencedThreadContexts: props.referencedEnvironmentId
      ? [{ environmentId: props.referencedEnvironmentId } as never]
      : [],
    activeProviderInstanceId: null,
    selectedProvider: codex,
    composerHasAttachments: false,
    activeProjectKey: `${mac}:${mocks.macScratch.workspaceRoot}`,
    activeProjectIsScratch: true,
    projectGroupingSettings: {} as never,
    sendInFlightRef: { current: false },
  });
  props.onRouting?.(routing);
  return null;
}

function deferOpens() {
  const opens: Array<(project: typeof boxScratch) => void> = [];
  mocks.openScratchProject.mockImplementation(() => new Promise((resolve) => opens.push(resolve)));
  return opens;
}

describe("useDraftEnvironmentRouting", () => {
  it("moves a no-project draft to the balanced machine, opening its no-project folder first", async () => {
    setup(boxScratch);

    // The harness only runs the hook and renders nothing routed.
    await using _screen = await render(<ScratchDraft />, { router: false });

    await vi.waitFor(() =>
      expect(mocks.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        `${box}:${boxScratch.workspaceRoot}`,
        { environmentId: box, projectId: boxScratch.id },
        draftId,
        { environmentSelection: "auto", loadBalancedEnvironmentId: box },
      ),
    );
    expect(mocks.openScratchProject).toHaveBeenCalledTimes(1);
  });

  it("keeps a no-project draft on its machine when the balanced machine cannot open one", async () => {
    setup(null);

    // The harness only runs the hook and renders nothing routed.
    await using _screen = await render(<ScratchDraft />, { router: false });

    await vi.waitFor(() =>
      expect(mocks.setDraftThreadContext).toHaveBeenCalledWith(draftId, {
        environmentSelection: "auto",
        loadBalancedEnvironmentId: mac,
      }),
    );
    expect(mocks.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });

  it.each([
    { change: "a file is attached", props: { eligible: false } },
    { change: "a thread on this machine is referenced", props: { referencedEnvironmentId: mac } },
  ])("drops a balanced move when $change while the folder opens", async ({ props }) => {
    setup(boxScratch);
    const opens = deferOpens();

    // The harness only runs the hook and renders nothing routed.
    await using screen = await render(<ScratchDraft />, { router: false });
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    await screen.rerender(<ScratchDraft {...props} />);
    await act(() => opens[0]?.(boxScratch));

    expect(mocks.draft.environmentId).toBe(mac);
    expect(mocks.draft.loadBalancedEnvironmentId).not.toBe(box);
  });

  it("lets Auto balance win over a manual switch that is still opening", async () => {
    setup(boxScratch);
    mocks.draft = { ...mocks.draft, environmentSelection: "manual" };
    const opens = deferOpens();
    let routing: Routing | undefined;

    // The harness only runs the hook and renders nothing routed.
    await using _screen = await render(<ScratchDraft onRouting={(next) => (routing = next)} />, {
      router: false,
    });
    await act(() => routing?.onEnvironmentChangeStable(box));
    await act(() => routing?.onAutoEnvironmentStable());
    await vi.waitFor(() => expect(opens).toHaveLength(2));
    await act(() => opens[0]?.(boxScratch));
    await act(() => opens[1]?.(boxScratch));

    expect(mocks.draft).toMatchObject({
      environmentId: box,
      environmentSelection: "auto",
      loadBalancedEnvironmentId: box,
    });
    expect(mocks.setLogicalProjectDraftThreadId).toHaveBeenCalledTimes(1);
  });
});
