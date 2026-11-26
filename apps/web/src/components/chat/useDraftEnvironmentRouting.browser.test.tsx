import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import type { EnvironmentPresentation } from "../../state/environments";
import type { ServerProvider, T3ProjectFile } from "@t3tools/contracts";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  EnvironmentId,
  GitRefName,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import { waitForPendingWorkspaceDefault } from "../../lib/retargetDraftWorkspace";
import { draftFanoutSelectionsAtom } from "./chatViewSend";

const resources = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  checkout: null as Promise<AtomCommandResult<{ refName: string }, never>> | null,
  projectFiles: new Map<EnvironmentId, Promise<T3ProjectFile | null>>(),
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
vi.mock("../../state/entities", async (original) => {
  const actual = await original<typeof import("../../state/entities")>();
  const readProject: typeof actual.readProject = (ref) =>
    resources.projects.find(
      (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
    ) ?? null;
  return {
    ...actual,
    useProjects: () => resources.projects,
    readThreadShells: () => [],
    readProject,
    useProject: (ref: Parameters<typeof actual.useProject>[0]) => (ref ? readProject(ref) : null),
  };
});
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/query", async (original) => ({
  ...(await original<typeof import("../../state/query")>()),
  useEnvironmentQuery: () => ({ data: null }),
}));
vi.mock("../../state/queries", async (original) => ({
  ...(await original<typeof import("../../state/queries")>()),
  usePaginatedBranches: () => ({
    refs: [
      { name: GitRefName.make("feature"), current: false, isDefault: false, worktreePath: null },
    ],
    data: { totalCount: 1, nextCursor: null },
    refresh: () => {},
  }),
}));
vi.mock("../../state/use-atom-command", async (original) => ({
  ...(await original<typeof import("../../state/use-atom-command")>()),
  useAtomCommand: () => async () =>
    resources.checkout ?? AsyncResult.success({ refName: "feature" }),
}));
vi.mock("../../lib/t3ProjectFileDefaults", () => ({
  peekT3ProjectFile: () => undefined,
  readT3ProjectFile: (environmentId: EnvironmentId) =>
    resources.projectFiles.get(environmentId) ?? Promise.resolve(null),
}));
vi.mock("../../state/presentation", async (original) => {
  const actual = await original<typeof import("../../state/presentation")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      connectedEnvironmentIdsAtom: Atom.make(() =>
        resources.projects.map((project) => project.environmentId),
      ),
    },
  };
});

vi.mock("../../hooks/useScratchProject", () => ({ useScratchProject: () => ({}) }));

function setup() {
  resources.refreshSelection.mockReset();
  resources.projectFiles.clear();
  resources.checkout = null;
  resources.pickedEnvironmentId = null;
  const a = EnvironmentId.make("machine-a");
  const b = EnvironmentId.make("machine-b");
  const draftId = DraftId.make("fresh-routing-draft");
  const projectId = ProjectId.make("project");
  resources.projects = [a, b].map((environmentId) => ({
    environmentId,
    id: projectId,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-10T01:00:00.000Z",
    updatedAt: "2026-11-10T01:00:00.000Z",
  }));
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
  showBranchPicker?: boolean;
}

function Harness(props: HarnessProps) {
  return (
    <AppAtomRegistryProvider>
      <RoutingProbe {...props} />
    </AppAtomRegistryProvider>
  );
}

function RoutingProbe({ input, onPrepared, showBranchPicker }: HarnessProps) {
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
      {showBranchPicker && draft && input.draftId ? (
        <BranchToolbarBranchSelector
          environmentId={draft.environmentId}
          threadId={draft.threadId}
          draftId={input.draftId}
          envLocked={false}
          startFromOrigin={false}
          onStartFromOriginChange={() => {}}
        />
      ) : null}
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
  const { a, b, draftId, input, store } = setup();
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

it.each(["initial routing", "pre-send refresh", "an edit during pre-send refresh"] as const)(
  "loads the destination workspace default during %s",
  async (route) => {
    const { b, draftId, input, store } = setup();
    const destinationFile = Promise.withResolvers<T3ProjectFile | null>();
    resources.projectFiles.set(b, destinationFile.promise);
    const onPrepared = vi.fn();
    if (route === "initial routing") {
      resources.pickedEnvironmentId = b;
      store.setDraftThreadContext(draftId, { loadBalancedEnvironmentId: null });
    }
    await using screen = await render(
      <Harness
        input={{ ...input, draftThread: store.getDraftSession(draftId) }}
        onPrepared={onPrepared}
      />,
    );
    if (route !== "initial routing") {
      await screen.getByRole("button", { name: "Send" }).click();
    }
    await expect.element(screen.getByText(b)).toBeInTheDocument();
    expect(store.getDraftSession(draftId)?.envMode).toBe("local");
    expect(onPrepared).not.toHaveBeenCalled();

    await act(async () => {
      if (route === "an edit during pre-send refresh") store.setPrompt(draftId, "Edited draft");
      destinationFile.resolve({ defaultThreadEnvMode: "worktree" });
      await destinationFile.promise;
    });
    expect(store.getDraftSession(draftId)?.envMode).toBe("worktree");
    if (route !== "initial routing") {
      expect(onPrepared).toHaveBeenCalledWith(route === "pre-send refresh");
    }
  },
);

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

it.each(["success", "failure"] as const)(
  "waits for the branch checkout before resolving the workspace on %s",
  async (outcome) => {
    const { b, draftId, input, store } = fanoutSetup();
    const destinationFile = Promise.withResolvers<T3ProjectFile | null>();
    const checkout = Promise.withResolvers<Awaited<NonNullable<typeof resources.checkout>>>();
    resources.projectFiles.set(b, destinationFile.promise);
    await using screen = await render(
      <Harness
        showBranchPicker
        input={{
          ...input,
          automaticEnvironment: false,
          draftThread: store.getDraftSession(draftId),
        }}
      />,
    );
    await screen.getByRole("button", { name: `Switch to ${b}` }).click();
    await expect.element(screen.getByText(b)).toBeInTheDocument();

    await screen.getByRole("combobox", { name: /Branch:/ }).click();
    resources.checkout = checkout.promise;
    await page.getByRole("option", { name: "feature" }).click();
    const pending = waitForPendingWorkspaceDefault(draftId);
    expect(pending).not.toBeNull();

    await act(async () => {
      destinationFile.resolve({ defaultThreadEnvMode: "worktree" });
      await destinationFile.promise;
    });
    expect(store.getDraftSession(draftId)?.envMode).toBe("local");
    await expect(Promise.race([pending, Promise.resolve("waiting")])).resolves.toBe("waiting");

    await act(async () => {
      checkout.resolve(
        outcome === "success"
          ? AsyncResult.success({ refName: "feature" })
          : AsyncResult.failure(Cause.interrupt()),
      );
      await pending;
    });
    expect(store.getDraftSession(draftId)).toMatchObject(
      outcome === "success"
        ? { branch: "feature", envMode: "local" }
        : { branch: null, envMode: "worktree" },
    );
  },
);
