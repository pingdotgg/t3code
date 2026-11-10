import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderDriverKind } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { render } from "../../../test/render";

const machineA = EnvironmentId.make("machine-a");
const machineB = EnvironmentId.make("machine-b");
const scratchProject = (environmentId: EnvironmentId) =>
  ({
    environmentId,
    id: ProjectId.make(`scratch-${environmentId}`),
    title: "No project",
    workspaceRoot: `/home/${environmentId}/.t3/scratch`,
    repositoryIdentity: null,
    isScratch: true,
  }) as unknown as EnvironmentProject;
const triagePrompt = (environmentId: EnvironmentId) =>
  `Read [triage-playbook.md](/home/${environmentId}/.t3/userdata/triage/session/triage-playbook.md) and follow it. `;

const prepareTriage = vi.fn(async ({ environmentId }: { environmentId: EnvironmentId }) => ({
  _tag: "Success" as const,
  value: { prompt: triagePrompt(environmentId) },
}));
function setup() {
  prepareTriage.mockClear();
}

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [scratchProject(machineA), scratchProject(machineB)],
}));
vi.mock(import("../../hooks/useScratchProject"), async (original) => ({
  ...(await original()),
  useScratchProject: () =>
    ({
      openScratchProject: async (environmentId: EnvironmentId) => scratchProject(environmentId),
    }) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      prepareTriage: "prepareTriage",
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomCommand: ((command: unknown, options: never) =>
      command === "prepareTriage"
        ? prepareTriage
        : actual.useAtomCommand(command as never, options)) as never,
  };
});

import { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";

it("a triage draft switched to another machine links a playbook prepared there", async () => {
  setup();
  const draftId = DraftId.make("draft-33771");
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(scopeProjectRef(machineA, scratchProject(machineA).id), draftId);
  store.setPrompt(draftId, triagePrompt(machineA));

  function Harness() {
    const draftThread = useComposerDraftStore((state) => state.getDraftSession(draftId));
    const routing = useDraftEnvironmentRouting({
      draftId,
      draftThread,
      envLocked: false,
      automaticEnvironment: false,
      logicalProjectEnvironments: [machineA, machineB].map((environmentId) => ({
        environmentId,
        // Machine B has no scratch project yet, as when triage started on A.
        projectId: environmentId === machineA ? scratchProject(machineA).id : null,
        label: environmentId,
        isPrimary: environmentId === machineB,
        machine: "server",
      })),
      environmentById: new Map(),
      providersByEnvironment: new Map(),
      loadBalancingSettings: { loadBalancingWeights: {} },
      referencedThreadContexts: [],
      activeProviderInstanceId: null,
      selectedProvider: ProviderDriverKind.make("codex"),
      composerHasAttachments: false,
      activeProjectKey: "scratch",
      activeProjectIsScratch: true,
      projectGroupingSettings: selectProjectGroupingSettings(DEFAULT_CLIENT_SETTINGS),
      sendInFlightRef: { current: false },
    });
    return (
      <button type="button" onClick={() => routing.onEnvironmentChangeStable(machineB)}>
        {draftThread?.environmentId}
      </button>
    );
  }

  // The hook reads no route.
  await using screen = await render(<Harness />, { router: false });
  await userEvent.click(screen.getByRole("button", { name: machineA }));
  await expect.element(screen.getByRole("button")).toHaveTextContent(machineB);

  await vi.waitFor(() => {
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      triagePrompt(machineB),
    );
  });
  expect(prepareTriage).toHaveBeenCalledWith(expect.objectContaining({ environmentId: machineB }));
});
