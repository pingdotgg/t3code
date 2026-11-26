import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import type { T3ProjectFile, VcsListRefsInput, VcsRef } from "@t3tools/contracts";
import type { EnvironmentPresentation } from "../../state/environments";
import type { ServerProvider } from "@t3tools/contracts";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { readPendingWorkspaceDefault } from "../../lib/draftWorkspaceDefaults";
import { draftFanoutSelectionsAtom } from "./chatViewSend";

const resources = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  refs: [] as VcsRef[],
  refsEnvironment: "machine-b",
  beforeRefs: vi.fn<() => Promise<void>>(),
  readProjectFile: vi.fn<() => Promise<T3ProjectFile | null>>(),
  pickedEnvironmentId: null as EnvironmentId | null,
  refreshSelection: vi.fn<(ids: readonly EnvironmentId[]) => Promise<EnvironmentId | null>>(),
}));
vi.mock("../../hooks/useLoadBalancedEnvironment", () => ({
  useLoadBalancedEnvironment: () => ({
    pending: false,
    failed: false,
    environmentId: resources.pickedEnvironmentId,
    refresh: () => {},
    refreshSelection: resources.refreshSelection,
  }),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => resources.projects,
  readThreadShells: () => [],
  readProject: (ref: { environmentId: EnvironmentId; projectId: ProjectId }) =>
    resources.projects.find(
      (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
    ) ?? null,
}));
vi.mock("../../hooks/useScratchProject", () => ({ useScratchProject: () => ({}) }));

vi.mock(import("../../state/vcs"), async (original) => {
  const { vcsEnvironment } = await original();
  const Effect = await import("effect/Effect");
  return {
    vcsEnvironment: {
      ...vcsEnvironment,
      readRefs: {
        ...vcsEnvironment.readRefs,
        run: (
          _registry,
          {
            environmentId,
            input,
          }: {
            environmentId: EnvironmentId;
            input: VcsListRefsInput;
          },
        ) =>
          Effect.promise(async () => {
            await resources.beforeRefs();
            const refs =
              environmentId === resources.refsEnvironment
                ? resources.refs.filter((ref) => {
                    if (
                      !input.includeMatchingRemoteRefs &&
                      ref.isRemote &&
                      resources.refs.some(
                        (local) => !local.isRemote && ref.name === `origin/${local.name}`,
                      )
                    )
                      return false;
                    return !input.query || ref.name.includes(input.query);
                  })
                : [];
            return {
              refs,
              isRepo: true,
              hasPrimaryRemote: false,
              nextCursor: null,
              totalCount: refs.length,
            };
          }),
      },
    },
  };
});
vi.mock(import("../../state/presentation"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { EnvironmentId } = await import("@t3tools/contracts");
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      connectedEnvironmentIdsAtom: Atom.make<ReadonlyArray<EnvironmentId>>([
        EnvironmentId.make("machine-b"),
      ]),
    },
  };
});
vi.mock("../../lib/t3ProjectFileDefaults", () => ({
  peekT3ProjectFile: () => undefined,
  readT3ProjectFile: () => resources.readProjectFile(),
}));

function setup() {
  resources.refreshSelection.mockReset();
  resources.readProjectFile.mockReset().mockResolvedValue(null);
  resources.refs = [];
  resources.refsEnvironment = "machine-b";
  resources.beforeRefs.mockReset().mockResolvedValue(undefined);
  resources.projects = [];
  resources.pickedEnvironmentId = null;
  const a = EnvironmentId.make("machine-a");
  const b = EnvironmentId.make("machine-b");
  const draftId = DraftId.make("fresh-routing-draft");
  const projectId = ProjectId.make("project");
  const store = useComposerDraftStore.getState();
  store.clearDraftThread(draftId);
  store.setProjectDraftThreadId(scopeProjectRef(a, projectId), draftId, {
    environmentSelection: "auto",
    loadBalancedEnvironmentId: a,
  });
  store.setPrompt(draftId, "Keep this prompt");
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    availability: "available",
    version: null,
    checkedAt: "2026-11-10T01:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const input: Parameters<typeof useDraftEnvironmentRouting>[0] = {
    draftId,
    draftThread: store.getDraftSession(draftId),
    envLocked: false,
    automaticEnvironment: true,
    logicalProjectEnvironments: [a, b].map((environmentId) => ({
      environmentId,
      projectId,
      label: environmentId,
      isPrimary: environmentId === a,
      machine: "desktop",
    })),
    environmentById: new Map(
      [a, b].map((id): [EnvironmentId, EnvironmentPresentation] => [
        id,
        {
          environmentId: id,
          label: id,
          displayUrl: null,
          relayManaged: false,
          entry: {
            target: new PrimaryConnectionTarget({
              environmentId: id,
              label: id,
              httpBaseUrl: "http://localhost:3000",
              wsBaseUrl: "ws://localhost:3000",
            }),
            profile: Option.none(),
            enabled: true,
          },
          connection: { phase: "connected", error: null, traceId: null },
          refusedRouteIds: [],
          serverConfig: null,
        },
      ]),
    ),
    providersByEnvironment: new Map([a, b].map((id) => [id, [provider]])),
    loadBalancingSettings: { loadBalancingWeights: {} },
    referencedThreadContexts: [],
    activeProviderInstanceId: provider.instanceId,
    selectedProvider: provider.driver,
    composerHasAttachments: false,
    activeProjectKey: "project",
    activeProjectIsScratch: false,
    projectGroupingSettings: DEFAULT_UNIFIED_SETTINGS,
    sendInFlightRef: { current: false },
  };
  resources.refreshSelection.mockImplementation(async (ids) => (ids.includes(b) ? b : null));
  return { a, b, draftId, input, store };
}

interface HarnessProps {
  input: Parameters<typeof useDraftEnvironmentRouting>[0];
  onPrepared?: (ready: boolean | null) => void;
}

function Harness(props: HarnessProps) {
  return (
    <AppAtomRegistryProvider>
      <RoutingProbe {...props} />
    </AppAtomRegistryProvider>
  );
}

function RoutingProbe({ input, onPrepared }: HarnessProps) {
  const routing = useDraftEnvironmentRouting(input);
  const draft = useComposerDraftStore((state) => state.getDraftSession(input.draftId!));
  const selections = useAtomValue(
    draftFanoutSelectionsAtom(
      scopedThreadKey(scopeThreadRef(draft!.environmentId, draft!.threadId)),
    ),
  );
  return (
    <>
      <output>
        {selections?.map((selection) => selection.model).join(", ") ?? "single model"}
      </output>
      {input.logicalProjectEnvironments.map(({ environmentId }) => (
        <button
          key={environmentId}
          onClick={() => routing.onEnvironmentChangeStable(environmentId)}
        >
          Switch to {environmentId}
        </button>
      ))}
      <span>{draft?.environmentId}</span>
      <button
        onClick={async () => {
          const ready = await routing.refreshBeforeSend();
          onPrepared?.(ready);
        }}
      >
        Send
      </button>
    </>
  );
}

it("refreshes a stored automatic choice before sending an unsent draft", async () => {
  const { a, b, draftId, input, store } = fanoutSetup();
  resources.refs = [{ name: "main", current: true, isDefault: true, worktreePath: null }];
  const selections = ["model-a", "model-b"].map((model) =>
    createModelSelection(ProviderInstanceId.make("codex"), model),
  );
  const threadId = input.draftThread!.threadId;
  const destinationSelections = draftFanoutSelectionsAtom(
    scopedThreadKey(scopeThreadRef(b, threadId)),
  );
  appAtomRegistry.set(destinationSelections, null);
  appAtomRegistry.set(
    draftFanoutSelectionsAtom(scopedThreadKey(scopeThreadRef(a, threadId))),
    selections,
  );
  store.setDraftThreadContext(draftId, {
    branch: "main",
    envMode: "worktree",
    workspaceExplicit: true,
    environmentSelection: "auto",
    loadBalancedEnvironmentId: a,
  });
  await using screen = await render(
    <Harness input={{ ...input, draftThread: store.getDraftSession(draftId) }} />,
  );
  await expect.element(screen.getByText(a)).toBeInTheDocument();
  await screen.getByRole("button", { name: "Send" }).click();
  await expect.element(screen.getByText(b)).toBeInTheDocument();
  expect(resources.refreshSelection).toHaveBeenCalledWith([a, b]);
  expect(store.getDraftSession(draftId)).toMatchObject({
    loadBalancedEnvironmentId: b,
    branch: "main",
    envMode: "worktree",
  });
  expect(store.getComposerDraft(draftId)?.prompt).toBe("Keep this prompt");
  expect(appAtomRegistry.get(destinationSelections)).toEqual(selections);
});

it.each(["manual", "attachments", "promoted"] as const)(
  "keeps the machine for %s drafts",
  async (kind) => {
    const { a, draftId, input, store } = setup();
    if (kind === "manual") store.setDraftThreadContext(draftId, { environmentSelection: "manual" });
    const guardedInput = {
      ...input,
      automaticEnvironment: kind !== "manual",
      composerHasAttachments: kind === "attachments",
      draftThread:
        kind === "promoted"
          ? {
              ...input.draftThread!,
              promotedTo: { environmentId: a, threadId: input.draftThread!.threadId },
            }
          : input.draftThread,
    };
    await using screen = await render(<Harness input={guardedInput} />);
    await screen.getByRole("button", { name: "Send" }).click();
    expect(resources.refreshSelection).not.toHaveBeenCalled();
    expect(store.getDraftSession(draftId)?.environmentId).toBe(a);
  },
);

it("does not reuse a stored choice when refreshed resources have no winner", async () => {
  const { a, input } = setup();
  resources.refreshSelection.mockResolvedValue(null);
  const onPrepared = vi.fn();
  await using screen = await render(<Harness input={input} onPrepared={onPrepared} />);
  await screen.getByRole("button", { name: "Send" }).click();
  await expect.element(screen.getByText(a)).toBeInTheDocument();
  await vi.waitFor(() => expect(onPrepared).toHaveBeenCalledWith(false));
});

it("abandons a refresh when the draft changes while resources are in flight", async () => {
  const { a, b, draftId, input, store } = setup();
  let resolve!: (environmentId: EnvironmentId) => void;
  resources.refreshSelection.mockReturnValue(
    new Promise<EnvironmentId>((done) => {
      resolve = done;
    }),
  );
  await using screen = await render(<Harness input={input} />);
  await screen.getByRole("button", { name: "Send" }).click();
  await act(async () => {
    store.setPrompt(draftId, "Edited while checking");
    resolve(b);
  });
  await expect.element(screen.getByText(a)).toBeInTheDocument();
  expect(store.getComposerDraft(draftId)?.prompt).toBe("Edited while checking");
});

function fanoutSetup() {
  const routing = setup();
  const { a, b, draftId, input, store } = routing;
  resources.projects = [a, b].map((environmentId) => ({
    environmentId,
    id: input.draftThread!.projectId,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-10T01:00:00.000Z",
    updatedAt: "2026-11-10T01:00:00.000Z",
  }));
  const threadId = input.draftThread!.threadId;
  const selectionsOn = (environmentId: EnvironmentId) =>
    draftFanoutSelectionsAtom(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  const models = (...names: string[]) =>
    names.map((model) => createModelSelection(ProviderInstanceId.make("codex"), model));
  appAtomRegistry.set(selectionsOn(b), null);
  appAtomRegistry.set(selectionsOn(a), models("gpt-6.1-sol", "gpt-6.1-luna"));
  store.setDraftThreadContext(draftId, {
    environmentSelection: "manual",
    loadBalancedEnvironmentId: null,
    branch: "main",
    envMode: "worktree",
  });
  return { ...routing, selectionsOn, models };
}

it.each([false, true])(
  "settles a cold destination workspace default after an automatic pick (explicit=%s)",
  async (explicit) => {
    const { b, draftId, input, store } = fanoutSetup();
    store.setDraftThreadContext(draftId, { envMode: "local", environmentSelection: "auto" });
    resources.pickedEnvironmentId = b;
    const file = Promise.withResolvers<T3ProjectFile>();
    resources.readProjectFile.mockReturnValue(file.promise);
    await using screen = await render(
      <Harness input={{ ...input, draftThread: store.getDraftSession(draftId) }} />,
    );
    await expect.element(screen.getByText(b)).toBeInTheDocument();
    const pending = readPendingWorkspaceDefault(draftId);
    expect(pending).not.toBeNull();
    await act(async () => {
      if (explicit) store.setDraftThreadContext(draftId, { workspaceExplicit: true });
      file.resolve({ defaultThreadEnvMode: "worktree" });
      await pending;
    });
    expect(store.getDraftSession(draftId)?.envMode).toBe(explicit ? "local" : "worktree");
  },
);

it.each([
  { branch: null, expected: "remote-base" },
  { branch: "source-only", expected: "remote-base" },
  { branch: "shared", expected: "shared" },
  { branch: "origin/release", expected: "origin/release" },
])("sends on a usable destination worktree base from $branch", async ({ branch, expected }) => {
  const { a, b, draftId, input, store } = fanoutSetup();
  store.setDraftThreadContext(draftId, {
    envMode: "local",
    branch,
    environmentSelection: "auto",
    loadBalancedEnvironmentId: a,
  });
  resources.refs = [
    { name: "remote-base", current: true, isDefault: true, worktreePath: null },
    { name: "shared", current: false, isDefault: false, worktreePath: null },
    { name: "release", current: false, isDefault: false, worktreePath: null },
    {
      name: "origin/release",
      isRemote: true,
      current: false,
      isDefault: false,
      worktreePath: null,
    },
  ];
  const file = Promise.withResolvers<T3ProjectFile>();
  resources.readProjectFile.mockReturnValue(file.promise);
  const onPrepared = vi.fn();
  await using screen = await render(
    <Harness
      input={{ ...input, draftThread: store.getDraftSession(draftId) }}
      onPrepared={onPrepared}
    />,
  );

  await screen.getByRole("button", { name: "Send" }).click();
  await vi.waitFor(() => expect(resources.readProjectFile).toHaveBeenCalled());
  expect(onPrepared).not.toHaveBeenCalled();
  await act(async () => file.resolve({ defaultThreadEnvMode: "worktree" }));
  await vi.waitFor(() => expect(onPrepared).toHaveBeenCalledWith(true));
  expect(store.getDraftSession(draftId)).toMatchObject({
    environmentId: b,
    envMode: "worktree",
    branch: expected,
  });
});

it.each([
  { branch: "main", selection: "auto", ready: true },
  { branch: "feature", selection: "manual", ready: false },
] as const)(
  "handles a $selection branch update while preparing Send",
  async ({ branch, selection, ready }) => {
    const { a, draftId, input, store } = fanoutSetup();
    store.setDraftThreadContext(draftId, {
      branch: null,
      envMode: "worktree",
      environmentSelection: "auto",
      loadBalancedEnvironmentId: a,
    });
    resources.refreshSelection.mockResolvedValue(a);
    resources.refsEnvironment = a;
    resources.refs = [{ name: "main", current: true, isDefault: true, worktreePath: null }];
    const refsReady = Promise.withResolvers<void>();
    resources.beforeRefs.mockReturnValue(refsReady.promise);
    const onPrepared = vi.fn();
    await using screen = await render(
      <Harness
        input={{ ...input, draftThread: store.getDraftSession(draftId) }}
        onPrepared={onPrepared}
      />,
    );
    await screen.getByRole("button", { name: "Send" }).click();
    await vi.waitFor(() => expect(resources.beforeRefs).toHaveBeenCalled());
    await act(async () => {
      store.setDraftThreadContext(draftId, { branch, environmentSelection: selection });
      refsReady.resolve();
    });
    await vi.waitFor(() => expect(onPrepared).toHaveBeenCalledWith(ready));
    expect(store.getDraftSession(draftId)?.branch).toBe(branch);
  },
);

it("abandons Send when the draft closes during the destination workspace read", async () => {
  const { a, draftId, input, store } = fanoutSetup();
  store.setDraftThreadContext(draftId, {
    environmentSelection: "auto",
    loadBalancedEnvironmentId: a,
  });
  const file = Promise.withResolvers<T3ProjectFile>();
  resources.readProjectFile.mockReturnValue(file.promise);
  const onPrepared = vi.fn();
  await using screen = await render(
    <Harness
      input={{ ...input, draftThread: store.getDraftSession(draftId) }}
      onPrepared={onPrepared}
    />,
  );
  await screen.getByRole("button", { name: "Send" }).click();
  await vi.waitFor(() => expect(resources.readProjectFile).toHaveBeenCalled());
  await screen.rerender(<p>Another thread</p>);
  await act(async () => file.resolve({ defaultThreadEnvMode: "local" }));
  await vi.waitFor(() => expect(onPrepared).toHaveBeenCalledWith(false));
  expect(store.getDraftSession(draftId)?.environmentId).toBe(a);
});

it("drops the source branch when Send moves to a current checkout", async () => {
  const { a, b, draftId, input, store } = fanoutSetup();
  store.setDraftThreadContext(draftId, {
    envMode: "worktree",
    branch: "source-only",
    environmentSelection: "auto",
    loadBalancedEnvironmentId: a,
  });
  resources.readProjectFile.mockResolvedValue({ defaultThreadEnvMode: "local" });
  const onPrepared = vi.fn();
  await using screen = await render(
    <Harness
      input={{ ...input, draftThread: store.getDraftSession(draftId) }}
      onPrepared={onPrepared}
    />,
  );
  await screen.getByRole("button", { name: "Send" }).click();
  await vi.waitFor(() => expect(onPrepared).toHaveBeenCalledWith(true));
  expect(store.getDraftSession(draftId)).toMatchObject({
    environmentId: b,
    envMode: "local",
    branch: null,
  });
});

it("keeps the selected models when the draft switches machine by hand", async () => {
  const { a, b, draftId, input, store, selectionsOn, models } = fanoutSetup();
  await using screen = await render(
    <Harness
      input={{ ...input, automaticEnvironment: false, draftThread: store.getDraftSession(draftId) }}
    />,
  );
  await expect.element(screen.getByText("gpt-6.1-sol, gpt-6.1-luna")).toBeInTheDocument();
  await screen.getByRole("button", { name: `Switch to ${b}` }).click();
  await expect.element(screen.getByText(b)).toBeInTheDocument();
  await expect.element(screen.getByText("gpt-6.1-sol, gpt-6.1-luna")).toBeInTheDocument();
  expect(store.getComposerDraft(draftId)?.prompt).toBe("Keep this prompt");

  // Changes made on the new machine come back with the draft.
  await act(async () => appAtomRegistry.set(selectionsOn(b), models("gpt-6.1-sol")));
  await screen.getByRole("button", { name: `Switch to ${a}` }).click();
  await expect.element(screen.getByText(a)).toBeInTheDocument();
  await expect.element(screen.getByText("gpt-6.1-sol", { exact: true })).toBeInTheDocument();
});

it("keeps the selected models when automatic routing picks another machine", async () => {
  const { b, draftId, input, store } = fanoutSetup();
  store.setDraftThreadContext(draftId, { environmentSelection: "auto" });
  resources.pickedEnvironmentId = b;
  await using screen = await render(
    <Harness input={{ ...input, draftThread: store.getDraftSession(draftId) }} />,
  );
  await expect.element(screen.getByText(b)).toBeInTheDocument();
  await expect.element(screen.getByText("gpt-6.1-sol, gpt-6.1-luna")).toBeInTheDocument();
});

it.each([
  { name: "takes the destination default", explicit: false, remoteDefault: true, model: "luna" },
  { name: "keeps a model the user picked", explicit: true, remoteDefault: true, model: "sol" },
  {
    name: "keeps the last-used model without a default",
    explicit: false,
    remoteDefault: false,
    model: "sol",
  },
])("$name when the draft switches machine by hand", async ({ explicit, remoteDefault, model }) => {
  const { b, draftId, input, store } = fanoutSetup();
  const codex = ProviderInstanceId.make("codex");
  resources.projects = resources.projects.map((project) =>
    project.environmentId === b && remoteDefault
      ? { ...project, defaultModelSelection: createModelSelection(codex, "luna") }
      : project,
  );
  store.setStickyModelSelection(createModelSelection(codex, "sol"));
  store.setModelSelection(draftId, createModelSelection(codex, "sol"), { explicit });
  await using screen = await render(
    <Harness
      input={{ ...input, automaticEnvironment: false, draftThread: store.getDraftSession(draftId) }}
    />,
  );
  await screen.getByRole("button", { name: `Switch to ${b}` }).click();
  await expect.element(screen.getByText(b)).toBeInTheDocument();
  const draft = store.getComposerDraft(draftId);
  expect(draft?.activeProvider).toBe(codex);
  expect(draft?.modelSelectionByProvider[codex]?.model).toBe(model);
  expect(draft?.modelSelectionExplicit === true).toBe(explicit);
});

it("takes the destination's default workspace when the draft switches machine by hand", async () => {
  const { b, draftId, input, store } = fanoutSetup();
  resources.projects = resources.projects.map((project) =>
    project.environmentId === b
      ? { ...project, defaultThreadEnvMode: "worktree" as const }
      : project,
  );
  // The source's own default, never picked by the user.
  store.setDraftThreadContext(draftId, { envMode: "local", startFromOrigin: false });
  await using screen = await render(
    <Harness
      input={{ ...input, automaticEnvironment: false, draftThread: store.getDraftSession(draftId) }}
    />,
  );
  await screen.getByRole("button", { name: `Switch to ${b}` }).click();
  await expect.element(screen.getByText(b)).toBeInTheDocument();
  expect(store.getDraftSession(draftId)?.envMode).toBe("worktree");
});

it("keeps a workspace the user picked when the draft switches machine by hand", async () => {
  const { b, draftId, input, store } = fanoutSetup();
  resources.projects = resources.projects.map((project) =>
    project.environmentId === b
      ? { ...project, defaultThreadEnvMode: "worktree" as const }
      : project,
  );
  // Picked by hand, even though it is also the source's default.
  store.setDraftThreadContext(draftId, {
    envMode: "local",
    startFromOrigin: false,
    workspaceExplicit: true,
  });
  await using screen = await render(
    <Harness
      input={{ ...input, automaticEnvironment: false, draftThread: store.getDraftSession(draftId) }}
    />,
  );
  await screen.getByRole("button", { name: `Switch to ${b}` }).click();
  await expect.element(screen.getByText(b)).toBeInTheDocument();
  expect(store.getDraftSession(draftId)?.envMode).toBe("local");
});
