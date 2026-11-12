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





describe("composerDraftStore model seed migration", () => {
  const staleDraftId = DraftId.make("draft-legacy-stale-model");
  const explicitDraftId = DraftId.make("draft-legacy-explicit-model");
  const typedDraftId = DraftId.make("draft-legacy-typed-model");
  const staleThreadId = ThreadId.make("thread-legacy-stale-model");
  const explicitThreadId = ThreadId.make("thread-legacy-explicit-model");
  const typedThreadId = ThreadId.make("thread-legacy-typed-model");
  const serverThreadId = ThreadId.make("thread-server-model");
  const serverThreadKey = scopedThreadKey(scopeThreadRef(TEST_ENVIRONMENT_ID, serverThreadId));
  const projectId = ProjectId.make("project-model-migration");
  const logicalProjectKey = `${TEST_ENVIRONMENT_ID}:/tmp/project-model-migration`;

  const draftThread = (threadId: ThreadId) => ({
    threadId,
    environmentId: TEST_ENVIRONMENT_ID,
    projectId,
    logicalProjectKey,
    createdAt: "2026-08-01T00:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    envMode: "local",
    startFromOrigin: false,
    promotedTo: null,
  });

  beforeEach(async () => {
    resetComposerDraftStore();
    await useComposerDraftStore.persist.clearStorage();
  });

  afterEach(async () => {
    await useComposerDraftStore.persist.clearStorage();
  });

  it.each([1, 2])(
    "keeps the legacy sticky Codex selection when v%s storage omitted the provider",
    async (version) => {
      vi.useFakeTimers();
      try {
        const stickySelection = modelSelection(CODEX_DRIVER, "gpt-5.6-terra", {
          reasoningEffort: "xhigh",
        });
        const storage = useComposerDraftStore.persist.getOptions().storage;
        expect(storage).toBeDefined();
        storage?.setItem(COMPOSER_DRAFT_STORAGE_KEY, {
          version,
          state: {
            draftsByThreadId: {},
            draftThreadsByThreadId: {},
            projectDraftThreadIdByProjectId: {},
            stickyModel: stickySelection.model,
            stickyModelOptions: providerModelOptions({
              [CODEX_DRIVER]: { reasoningEffort: "xhigh" },
            }),
          },
        } as never);
        await vi.advanceTimersByTimeAsync(300);

        await useComposerDraftStore.persist.rehydrate();

        expect(useComposerDraftStore.getState()).toMatchObject({
          stickyModelSelectionByProvider: { [CODEX_INSTANCE]: stickySelection },
          stickyActiveProvider: null,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("strips seeded models only from empty draft sessions when upgrading storage", async () => {
    vi.useFakeTimers();
    try {
      const staleSelection = modelSelection(CODEX_DRIVER, "gpt-5.4");
      const stickySelection = modelSelection(CODEX_DRIVER, "gpt-5.6-terra", {
        reasoningEffort: "xhigh",
      });
      const storage = useComposerDraftStore.persist.getOptions().storage;
      expect(storage).toBeDefined();
      storage?.setItem(COMPOSER_DRAFT_STORAGE_KEY, {
        version: 8,
        state: {
          draftsByThreadKey: {
            [staleDraftId]: {
              prompt: "",
              attachments: [],
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              activeProvider: CODEX_INSTANCE,
              runtimeMode: "approval-required",
            },
            [typedDraftId]: {
              prompt: "keep this prompt",
              attachments: [],
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              activeProvider: CODEX_INSTANCE,
            },
            [explicitDraftId]: {
              prompt: "",
              attachments: [],
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              activeProvider: CODEX_INSTANCE,
              modelSelectionExplicit: true,
            },
            [serverThreadKey]: {
              prompt: "",
              attachments: [],
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              activeProvider: CODEX_INSTANCE,
            },
          },
          draftThreadsByThreadKey: {
            [staleDraftId]: draftThread(staleThreadId),
            [explicitDraftId]: draftThread(explicitThreadId),
            [typedDraftId]: draftThread(typedThreadId),
          },
          logicalProjectDraftThreadKeyByLogicalProjectKey: {
            [logicalProjectKey]: staleDraftId,
          },
          stickyModelSelectionByProvider: { [CODEX_INSTANCE]: stickySelection },
          stickyActiveProvider: CODEX_INSTANCE,
        },
      } as never);
      await vi.advanceTimersByTimeAsync(300);

      await useComposerDraftStore.persist.rehydrate();

      expect(draftByKey(staleDraftId)).toMatchObject({
        modelSelectionByProvider: {},
        activeProvider: null,
        runtimeMode: "approval-required",
      });
      expect(draftByKey(typedDraftId)).toMatchObject({
        prompt: "keep this prompt",
        modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
        activeProvider: CODEX_INSTANCE,
      });
      expect(draftByKey(explicitDraftId)).toMatchObject({
        modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
        activeProvider: CODEX_INSTANCE,
        modelSelectionExplicit: true,
      });
      expect(draftByKey(serverThreadKey)).toMatchObject({
        modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
        activeProvider: CODEX_INSTANCE,
      });
      expect(useComposerDraftStore.getState().draftThreadsByThreadKey[staleDraftId]).toMatchObject({
        environmentId: TEST_ENVIRONMENT_ID,
        projectId,
        logicalProjectKey,
      });
      expect(useComposerDraftStore.getState()).toMatchObject({
        stickyModelSelectionByProvider: { [CODEX_INSTANCE]: stickySelection },
        stickyActiveProvider: CODEX_INSTANCE,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps v8 file-only draft sessions and their seeded models", async () => {
    vi.useFakeTimers();
    try {
      const uploadedDraftId = DraftId.make("draft-legacy-uploaded-file");
      const markerDraftId = DraftId.make("draft-legacy-file-marker");
      const uploadedThreadId = ThreadId.make("thread-legacy-uploaded-file");
      const markerThreadId = ThreadId.make("thread-legacy-file-marker");
      const staleSelection = modelSelection(CODEX_DRIVER, "gpt-5.4");
      const storage = useComposerDraftStore.persist.getOptions().storage;
      expect(storage).toBeDefined();
      storage?.setItem(COMPOSER_DRAFT_STORAGE_KEY, {
        version: 8,
        state: {
          draftsByThreadKey: {
            [uploadedDraftId]: {
              prompt: "",
              attachments: [],
              files: [
                {
                  id: "file-uploaded",
                  name: "uploaded-report.pdf",
                  mimeType: "application/pdf",
                  sizeBytes: 128,
                  attachmentId: "attachment-uploaded",
                  environmentId: TEST_ENVIRONMENT_ID,
                },
              ],
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              activeProvider: CODEX_INSTANCE,
            },
            [markerDraftId]: {
              prompt: "",
              attachments: [],
              files: [
                {
                  id: "file-needs-reattach",
                  name: "local-notes.txt",
                  mimeType: "text/plain",
                  sizeBytes: 64,
                },
              ],
              modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
              activeProvider: CODEX_INSTANCE,
              runtimeMode: "approval-required",
            },
          },
          draftThreadsByThreadKey: {
            [uploadedDraftId]: draftThread(uploadedThreadId),
            [markerDraftId]: draftThread(markerThreadId),
          },
          logicalProjectDraftThreadKeyByLogicalProjectKey: {},
          stickyModelSelectionByProvider: {},
          stickyActiveProvider: null,
        },
      } as never);
      await vi.advanceTimersByTimeAsync(300);

      await useComposerDraftStore.persist.rehydrate();

      expect(draftByKey(uploadedDraftId)).toMatchObject({
        files: [
          {
            id: "file-uploaded",
            name: "uploaded-report.pdf",
            uploadedAttachmentId: "attachment-uploaded",
            uploadEnvironmentId: TEST_ENVIRONMENT_ID,
          },
        ],
        modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
        activeProvider: CODEX_INSTANCE,
      });
      expect(draftByKey(markerDraftId)).toMatchObject({
        files: [
          {
            id: "file-needs-reattach",
            name: "local-notes.txt",
            file: null,
          },
        ],
        modelSelectionByProvider: { [CODEX_INSTANCE]: staleSelection },
        activeProvider: CODEX_INSTANCE,
        runtimeMode: "approval-required",
      });
      expect(draftByKey(markerDraftId)?.files.every(composerFileNeedsReattach)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("upgrades v5 selections that name a provider and keep options in an object", async () => {
    vi.useFakeTimers();
    try {
      const legacySelection = {
        provider: "codex",
        model: "gpt-5.4",
        options: { reasoningEffort: "high", fastMode: true },
      };
      const storage = useComposerDraftStore.persist.getOptions().storage;
      expect(storage).toBeDefined();
      storage?.setItem(COMPOSER_DRAFT_STORAGE_KEY, {
        version: 5,
        state: {
          draftsByThreadKey: {
            [serverThreadKey]: {
              prompt: "keep this draft",
              attachments: [],
              modelSelectionByProvider: { codex: legacySelection },
              activeProvider: "codex",
            },
          },
          draftThreadsByThreadKey: {},
          stickyModelSelectionByProvider: { codex: legacySelection },
          stickyActiveProvider: "codex",
        },
      } as never);
      await vi.advanceTimersByTimeAsync(300);

      await useComposerDraftStore.persist.rehydrate();

      const upgraded = modelSelection(CODEX_DRIVER, "gpt-5.4", {
        reasoningEffort: "high",
        fastMode: true,
      });
      expect(draftByKey(serverThreadKey)).toMatchObject({
        prompt: "keep this draft",
        modelSelectionByProvider: { [CODEX_INSTANCE]: upgraded },
      });
      expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual({
        [CODEX_INSTANCE]: upgraded,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

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

