import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { createEnvironmentThreadShellAtoms } from "@t3tools/client-runtime/state/threads";
import {
  applyShellStreamEvent,
  createEnvironmentSnapshotAtom,
  EMPTY_SHELL_STATE,
  type EnvironmentShellState,
  type EnvironmentShellStatus,
} from "@t3tools/client-runtime/state/shell";
import { makeThreadProjectionFixture } from "./test-fixtures";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  defaultInstanceIdForDriver,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ShellSnapshot,
  type ModelSelection,
  type PreviewAnnotationPayload,
  type ProviderOptionSelection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const CODEX_SECONDARY_INSTANCE = ProviderInstanceId.make("codex_secondary");
const CLAUDE_AGENT_INSTANCE = ProviderInstanceId.make("claudeAgent");
const CURSOR_INSTANCE = ProviderInstanceId.make("cursor");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

type ProviderOptionSelectionBag = ReadonlyArray<ProviderOptionSelection>;
type ProviderOptionSelectionsByProvider = Partial<Record<string, ProviderOptionSelectionBag>>;

function toSelections(
  options: Record<string, string | boolean | undefined> | undefined,
): ReadonlyArray<ProviderOptionSelection> {
  const result: Array<ProviderOptionSelection> = [];
  if (!options) return result;
  for (const [id, value] of Object.entries(options)) {
    if (typeof value === "string" || typeof value === "boolean") {
      result.push({ id, value });
    }
  }
  return result;
}

function selectionsByProvider(
  options: Partial<Record<ProviderDriverKind, Record<string, string | boolean | undefined>>>,
): ProviderOptionSelectionsByProvider {
  const result: ProviderOptionSelectionsByProvider = {};
  for (const [provider, bag] of Object.entries(options) as Array<
    [ProviderDriverKind, Record<string, string | boolean | undefined>]
  >) {
    result[provider] = toSelections(bag);
  }
  return result;
}
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  subscribeComposerDraftModelReconciliation,
  deriveEffectiveComposerModelState,
  clearComposerDraftsEnvironment,
  beginBackgroundDraftSubmissionByRef,
  clearBackgroundDraftSubmissionByRef,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  resolveDraftPromotionNavigationTarget,
  restoreFailedDraftThread,
  subscribeDraftThreadPromotion,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  composerFileNeedsReattach,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
  DraftId,
} from "./composerDraftStore";
import { waitForDraftHeroTransition } from "./components/chat/draftHeroTransition";
import { insertInlineContextReference } from "./lib/composerContextReferences";
import {
  buildMessageContext,
  environmentContextRecord,
  terminalContextReference,
} from "./lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import {
  copiedComposerAttachmentFile,
  rememberCopiedComposerAttachments,
} from "./lib/copiedComposerAttachments";
import { formatTerminalContextReference, type TerminalContextDraft } from "./lib/terminalContext";
import { createDeferredStorage } from "./lib/storage";
import { applyPreviewServerSnapshot, resetPreviewStateForTests } from "./previewStateStore";

function makeImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 4;
  const lastModified = input.lastModified ?? 1_700_000_000_000;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

function makeFile(id: string): ComposerFileAttachment {
  const file = new File(["report"], "report.pdf", { type: "application/pdf" });
  return {
    type: "file",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
}

function makeTerminalContext(input: {
  id: string;
  text?: string;
  terminalId?: string;
  terminalLabel?: string;
  lineStart?: number;
  lineEnd?: number;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: ThreadId.make("thread-dedupe"),
    terminalId: input.terminalId ?? "default",
    terminalLabel: input.terminalLabel ?? "Terminal 1",
    lineStart: input.lineStart ?? 4,
    lineEnd: input.lineEnd ?? 5,
    text: input.text ?? "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
  };
}

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    backgroundSubmissionThreadKeys: {},
    promotedDraftRedirects: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
}

function modelSelection(
  provider: ProviderDriverKind,
  model: string,
  options?: Record<string, string | boolean | undefined>,
): ModelSelection {
  return createModelSelection(defaultInstanceIdForDriver(provider), model, toSelections(options));
}

function providerModelOptions(
  options: Partial<Record<string, Record<string, string | boolean | undefined>>>,
): ProviderOptionSelectionsByProvider {
  return selectionsByProvider(options);
}

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const OTHER_TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");
const LEGACY_TEST_ENVIRONMENT_ID = EnvironmentId.make("__legacy__");

function threadKeyFor(
  threadId: ThreadId,
  environmentId: EnvironmentId = LEGACY_TEST_ENVIRONMENT_ID,
): string {
  if (environmentId === LEGACY_TEST_ENVIRONMENT_ID) {
    return threadId;
  }
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function draftFor(threadId: ThreadId, environmentId: EnvironmentId = LEGACY_TEST_ENVIRONMENT_ID) {
  const store = useComposerDraftStore.getState().draftsByThreadKey;
  return store[threadKeyFor(threadId, environmentId)] ?? store[threadId] ?? undefined;
}

function draftByKey(key: string) {
  return useComposerDraftStore.getState().draftsByThreadKey[key] ?? undefined;
}










function modelReconciliationHarness(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  initialStatus: EnvironmentShellStatus = "live",
) {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  onTestFinished(() => registry.dispose());
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  const selectedThreadId = ThreadId.make("another-selected-thread");
  const thread: OrchestrationV2ThreadShell = {
    ...makeThreadProjectionFixture().thread,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
  };
  const initialSnapshot: OrchestrationV2ShellSnapshot = {
    schemaVersion: 1,
    snapshotSequence: 0,
    projects: [],
    archivedThreads: [],
    threads: [
      { ...thread, id: threadId },
      { ...thread, id: selectedThreadId },
    ],
  };
  const shellStateAtom = Atom.make<EnvironmentShellState>({
    ...EMPTY_SHELL_STATE,
    snapshot: Option.some(initialSnapshot),
    status: initialStatus,
  });
  const shellResultAtom = Atom.map(shellStateAtom, AsyncResult.success);
  const snapshotAtom = createEnvironmentSnapshotAtom(() => shellResultAtom)(environmentId);
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map([
      [
        environmentId,
        {
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ],
    ]),
  });
  const shells = createEnvironmentThreadShellAtoms({
    catalogValueAtom,
    snapshotAtom: () => snapshotAtom,
    hiddenThreadTagsAtom: () => Atom.make(null),
  });
  const selectedShell = shells.threadShellAtom({ environmentId, threadId: selectedThreadId });
  onTestFinished(registry.mount(selectedShell));
  onTestFinished(
    subscribeComposerDraftModelReconciliation({
      registry,
      threadShellAtom: shells.threadShellAtom,
      threadRefsAtom: shells.threadRefsAtom,
      shellStateAtom: () => shellResultAtom,
    }),
  );
  flush();
  return {
    flush,
    setStatus(status: EnvironmentShellStatus) {
      registry.set(shellStateAtom, { ...registry.get(shellStateAtom), status });
      flush();
    },
    update(changes: Partial<OrchestrationV2ThreadShell>, status?: EnvironmentShellStatus) {
      const state = registry.get(shellStateAtom);
      const snapshot = Option.getOrThrow(state.snapshot);
      registry.set(shellStateAtom, {
        ...state,
        status: status ?? state.status,
        snapshot: Option.some(
          applyShellStreamEvent(snapshot, {
            kind: "thread.updated",
            location: "active",
            sequence: snapshot.snapshotSequence + 1,
            thread: { ...snapshot.threads[0]!, ...changes },
          }),
        ),
      });
      flush();
      expect(registry.get(selectedShell)?.id).toBe(selectedThreadId);
    },
    model: () => registry.get(shells.threadShellAtom({ environmentId, threadId }))!.modelSelection,
  };
}

type PromotionShell = NonNullable<
  Parameters<typeof resolveDraftPromotionNavigationTarget>[0]["serverThread"]
>;

function draftPromotionHarness() {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  onTestFinished(() => registry.dispose());
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  const threadRefsAtom = Atom.make<ReadonlyArray<ScopedThreadRef>>([]);
  const shellAtoms = new Map<string, Atom.Writable<PromotionShell | null>>();
  const shellAtom = (ref: ScopedThreadRef) => {
    const key = scopedThreadKey(ref);
    let atom = shellAtoms.get(key);
    if (!atom) {
      atom = Atom.make<PromotionShell | null>(null);
      shellAtoms.set(key, atom);
    }
    return atom;
  };
  onTestFinished(
    subscribeDraftThreadPromotion({ registry, threadRefsAtom, threadShellAtom: shellAtom }),
  );
  flush();
  return {
    flush,
    arrive(ref: ScopedThreadRef, shell: PromotionShell | null = null) {
      registry.set(shellAtom(ref), shell);
      registry.set(threadRefsAtom, [...registry.get(threadRefsAtom), ref]);
      flush();
    },
    updateShell(ref: ScopedThreadRef, shell: PromotionShell) {
      registry.set(shellAtom(ref), shell);
      flush();
    },
  };
}






function createMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((name: string) => store.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      store.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      store.delete(name);
    }),
  };
}





describe("composerDraftStore modelSelection", () => {
  const threadId = ThreadId.make("thread-model-options");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("retains a pick matching cached state until the live shell confirms it", () => {
    const h = modelReconciliationHarness(TEST_ENVIRONMENT_ID, threadId, "cached");
    const pick = h.model();
    useComposerDraftStore.getState().setModelSelection(threadRef, pick, { explicit: true });
    h.flush();
    const before = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(before?.modelSelectionByProvider[pick.instanceId]).toEqual(pick);

    for (const status of ["empty", "synchronizing", "cached"] as const) {
      h.setStatus(status);
      expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toEqual(before);
    }
    h.update({ modelSelection: { ...pick, model: "remote-model" } }, "live");
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toEqual(before);
    h.update({ modelSelection: pick }, "synchronizing");
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toEqual(before);
    h.setStatus("live");
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("releases an inactive thread pick only after its queued model becomes durable", () => {
    const store = useComposerDraftStore.getState();
    const pick = modelSelection(CODEX_DRIVER, "gpt-5.5", { fastMode: false });
    store.setPrompt(threadRef, "keep this unsent follow-up");
    store.addImage(threadRef, makeImage({ id: "image", previewUrl: "blob:keep-image" }));
    store.setTerminalContexts(threadRef, [makeTerminalContext({ id: "terminal" })]);
    store.setRuntimeMode(threadRef, "approval-required");
    store.setInteractionMode(threadRef, "plan");
    store.setModelSelection(threadRef, pick, { explicit: true });
    const before = draftFor(threadId, TEST_ENVIRONMENT_ID)!;
    const remoteRef = scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, threadId);
    store.setModelSelection(remoteRef, pick, { explicit: true });
    const remoteBefore = draftFor(threadId, OTHER_TEST_ENVIRONMENT_ID);
    const h = modelReconciliationHarness(TEST_ENVIRONMENT_ID, threadId);

    h.update({ status: "queued" });
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toEqual(before);
    h.update({ status: "running", modelSelection: modelSelection(CODEX_DRIVER, "gpt-5.5") });
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toEqual({
      ...before,
      activeProvider: null,
      modelSelectionByProvider: {},
      modelSelectionExplicit: undefined,
    });
    expect(draftFor(threadId, OTHER_TEST_ENVIRONMENT_ID)).toEqual(remoteBefore);

    const remoteModel = DEFAULT_MODEL_BY_PROVIDER[CLAUDE_AGENT_DRIVER]!;
    h.update({ modelSelection: modelSelection(CLAUDE_AGENT_DRIVER, remoteModel) });
    const effective = deriveEffectiveComposerModelState({
      draft: draftFor(threadId, TEST_ENVIRONMENT_ID),
      providers: [
        {
          instanceId: CLAUDE_AGENT_INSTANCE,
          driver: CLAUDE_AGENT_DRIVER,
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-01-01T00:00:00.000Z",
          models: [{ slug: remoteModel, name: remoteModel, isCustom: false, capabilities: {} }],
          slashCommands: [],
          skills: [],
        },
      ],
      selectedProvider: CLAUDE_AGENT_DRIVER,
      selectedInstanceId: CLAUDE_AGENT_INSTANCE,
      threadModelSelection: h.model(),
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });
    expect(effective.selectedModel).toBe(remoteModel);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider).toEqual({});
  });

  it("retains an unavailable provider pick through differing durable model updates", () => {
    const store = useComposerDraftStore.getState();
    const pick = createModelSelection(CODEX_SECONDARY_INSTANCE, "gpt-5.5", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    // A remembered primary pick is the visible fallback while the secondary is unavailable.
    const primary = modelSelection(CODEX_DRIVER, DEFAULT_MODEL);
    store.setModelSelection(threadRef, primary);
    store.setModelSelection(threadRef, pick, { explicit: true });
    const before = draftFor(threadId, TEST_ENVIRONMENT_ID);
    const h = modelReconciliationHarness(TEST_ENVIRONMENT_ID, threadId);
    h.update({ modelSelection: primary });
    const fallback = deriveEffectiveComposerModelState({
      draft: before,
      providers: [],
      selectedProvider: CODEX_DRIVER,
      selectedInstanceId: CODEX_INSTANCE,
      threadModelSelection: h.model(),
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });
    expect(fallback.selectedModel).toBe(h.model().model);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toEqual(before);

    for (const modelSelection of [
      { ...pick, instanceId: CODEX_INSTANCE },
      { ...pick, model: "gpt-5.4" },
      { ...pick, options: [{ id: "reasoningEffort", value: "high" }] },
      {
        ...pick,
        options: [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: true },
        ],
      },
    ]) {
      h.update({ modelSelection });
      expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toEqual(before);
    }
    h.update({ modelSelection: { ...pick, options: pick.options!.toReversed() } });
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("marks picker writes explicit and seeding writes non-explicit", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionExplicit).toBeUndefined();

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"), {
      explicit: true,
    });
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionExplicit).toBe(true);

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"), {
      replaceOptions: true,
    });
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionExplicit).toBeUndefined();
  });

  it("replaces only the targeted provider options on the current model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );
    store.setStickyModelSelection(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );

    store.setProviderModelOptions(
      threadRef,
      CLAUDE_AGENT_DRIVER,
      toSelections({ thinking: false }),
      {
        persistSticky: true,
      },
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        thinking: false,
      }),
    );
  });

  // regression: #6011 new threads ignored project default models unless edits are marked explicit
  it("marks trait edits as explicit model intent", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionExplicit).toBeUndefined();

    store.setProviderModelOptions(
      threadRef,
      CODEX_DRIVER,
      toSelections({ reasoningEffort: "xhigh" }),
    );

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionExplicit).toBe(true);
    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(modelSelection(CODEX_DRIVER, "gpt-5.4", { reasoningEffort: "xhigh" }));
  });

  it("stores provider option changes on a selected custom instance", () => {
    const store = useComposerDraftStore.getState();

    store.setProviderModelOptions(
      threadRef,
      CODEX_DRIVER,
      toSelections({ reasoningEffort: "low" }),
      {
        instanceId: CODEX_SECONDARY_INSTANCE,
        model: "gpt-5-codex",
        persistSticky: true,
      },
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_SECONDARY_INSTANCE],
    ).toEqual(
      expect.objectContaining({
        instanceId: CODEX_SECONDARY_INSTANCE,
        model: "gpt-5-codex",
        options: [{ id: "reasoningEffort", value: "low" }],
      }),
    );
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.activeProvider).toBe(CODEX_SECONDARY_INSTANCE);
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe(CODEX_SECONDARY_INSTANCE);
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toBe(
      undefined,
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_SECONDARY_INSTANCE],
    ).toEqual(
      expect.objectContaining({
        instanceId: CODEX_SECONDARY_INSTANCE,
        options: [{ id: "reasoningEffort", value: "low" }],
      }),
    );
    expect(
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[CODEX_SECONDARY_INSTANCE],
    ).toEqual({ "gpt-5-codex": [{ id: "reasoningEffort", value: "low" }] });

    // A custom slug that matches a Codex alias stays exact; the picker already resolved it.
    store.setModelSelection(threadRef, createModelSelection(CODEX_SECONDARY_INSTANCE, "gpt-5.3"), {
      explicit: true,
      replaceOptions: true,
    });
    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_SECONDARY_INSTANCE]
        ?.model,
    ).toBe("gpt-5.3");
  });
});

