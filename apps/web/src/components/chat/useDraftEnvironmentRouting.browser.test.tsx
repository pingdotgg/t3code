import { EnvironmentId, ProjectId, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
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
  useLoadBalancedEnvironment: () => ({
    refresh: () => {},
    pending: false,
    environmentId: "box",
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

function ScratchDraft() {
  const draftThread = useComposerDraftStore((store) => store.getDraftSession(draftId));
  useDraftEnvironmentRouting({
    draftId,
    draftThread,
    envLocked: false,
    automaticEnvironment: true,
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
    referencedThreadContexts: [],
    activeProviderInstanceId: null,
    selectedProvider: codex,
    composerHasAttachments: false,
    activeProjectKey: `${mac}:${mocks.macScratch.workspaceRoot}`,
    activeProjectIsScratch: true,
    projectGroupingSettings: {} as never,
    sendInFlightRef: { current: false },
  });
  return null;
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
});
