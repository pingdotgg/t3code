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





describe("composerDraftStore project draft thread mapping", () => {
  const projectId = ProjectId.make("project-a");
  const otherProjectId = ProjectId.make("project-b");
  const projectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, projectId);
  const otherProjectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, otherProjectId);
  const remoteProjectRef = scopeProjectRef(OTHER_TEST_ENVIRONMENT_ID, projectId);
  const threadId = ThreadId.make("thread-a");
  const otherThreadId = ThreadId.make("thread-b");
  const draftId = DraftId.make("draft-a");
  const otherDraftId = DraftId.make("draft-b");
  const sharedDraftId = DraftId.make("draft-shared");
  const localDraftId = DraftId.make("draft-local");
  const remoteDraftId = DraftId.make("draft-remote");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("clears composer data for one environment without touching another", () => {
    const store = useComposerDraftStore.getState();
    const localThreadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
    const remoteThreadRef = scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, otherThreadId);
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokeSpy = vi.fn<(url: string) => void>();
    URL.revokeObjectURL = revokeSpy;

    try {
      store.setProjectDraftThreadId(projectRef, localDraftId, { threadId });
      store.setProjectDraftThreadId(remoteProjectRef, remoteDraftId, {
        threadId: otherThreadId,
      });
      store.setPrompt(localDraftId, "local draft");
      store.setPrompt(remoteDraftId, "remote draft");
      store.addImage(localDraftId, makeImage({ id: "img-local", previewUrl: "blob:local-draft" }));
      store.setPrompt(localThreadRef, "local thread draft");
      store.setPrompt(remoteThreadRef, "remote thread draft");
      useComposerDraftStore.setState({
        rewindingThreadKeys: new Set([
          threadKeyFor(threadId, TEST_ENVIRONMENT_ID),
          threadKeyFor(otherThreadId, OTHER_TEST_ENVIRONMENT_ID),
        ]),
      });

      clearComposerDraftsEnvironment(TEST_ENVIRONMENT_ID);

      const next = useComposerDraftStore.getState();
      expect([...next.rewindingThreadKeys]).toEqual([
        threadKeyFor(otherThreadId, OTHER_TEST_ENVIRONMENT_ID),
      ]);
      expect(next.getDraftThreadByProjectRef(projectRef)).toBeNull();
      expect(next.getDraftThreadByProjectRef(remoteProjectRef)).not.toBeNull();
      expect(next.getComposerDraft(localDraftId)).toBeNull();
      expect(next.getComposerDraft(remoteDraftId)?.prompt).toBe("remote thread draft");
      expect(next.getComposerDraft(localThreadRef)).toBeNull();
      expect(next.getComposerDraft(remoteThreadRef)?.prompt).toBe("remote thread draft");
      expect(revokeSpy).toHaveBeenCalledWith("blob:local-draft");
    } finally {
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });

  it("removes a draft's previous project mapping when retargeted in place", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "keep this prompt");

    store.setProjectDraftThreadId(otherProjectRef, draftId, { threadId });

    expect(store.getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(store.getDraftThreadByProjectRef(otherProjectRef)?.draftId).toBe(draftId);
    expect(store.getComposerDraft(draftId)?.prompt).toBe("keep this prompt");
  });

  it("rotates a failed bootstrap thread id without losing its draft", () => {
    const store = useComposerDraftStore.getState();
    const retryThreadId = ThreadId.make("thread-retry");
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: "feature/test",
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      envMode: "worktree",
      startFromOrigin: true,
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    store.setPrompt(draftId, "keep this prompt");
    markPromotedDraftThreadByRef(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId));

    store.setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, draftId, {
      threadId: retryThreadId,
      createdAt: "2026-01-01T00:01:00.000Z",
    });

    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      threadId: retryThreadId,
      branch: "feature/test",
      worktreePath: null,
      createdAt: "2026-01-01T00:01:00.000Z",
      envMode: "worktree",
      startFromOrigin: true,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      promotedTo: null,
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "keep this prompt",
    );
  });

  it("clears only matching project draft mapping entries", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "hello");

    store.clearProjectDraftThreadById(projectRef, otherDraftId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      threadId,
    );

    store.clearProjectDraftThreadById(projectRef, draftId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  // regression: #1264 deleting a project must release its draft thread's image blob URLs
  it("revokes draft image blob URLs when clearing a project's draft thread", () => {
    const store = useComposerDraftStore.getState();
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokeSpy = vi.fn<(url: string) => void>();
    URL.revokeObjectURL = revokeSpy;

    try {
      store.setProjectDraftThreadId(projectRef, draftId, { threadId });
      store.addImage(draftId, makeImage({ id: "img-project-clear", previewUrl: "blob:clear" }));

      store.clearProjectDraftThreadId(projectRef);

      expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
      expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
      expect(revokeSpy).toHaveBeenCalledWith("blob:clear");
    } finally {
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }
  });

  it("clears empty composer drafts when remapping a project to a new draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });

    store.setProjectDraftThreadId(projectRef, otherDraftId, { threadId: otherThreadId });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      otherThreadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("keeps a draft with an open page when remapping a project to a new draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    applyPreviewServerSnapshot(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId), {
      threadId,
      tabId: "tab-link",
      navStatus: { _tag: "Success", url: "https://example.com/", title: "Example" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-10-09T00:00:00.000Z",
    });
    try {
      store.setProjectDraftThreadId(projectRef, otherDraftId, { threadId: otherThreadId });

      expect(useComposerDraftStore.getState().getDraftThread(draftId)?.threadId).toBe(threadId);
      const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
      expect(persisted.draftThreadsByThreadKey[draftId]?.threadId).toBe(threadId);
    } finally {
      resetPreviewStateForTests();
    }
  });

  it("keeps invested composer drafts alive unmapped when remapping a project to a new draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "keep me around");

    store.setProjectDraftThreadId(projectRef, otherDraftId, { threadId: otherThreadId });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      otherThreadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.threadId).toBe(threadId);
    expect(draftByKey(draftId)?.prompt).toBe("keep me around");
  });

  it("clears every session for a project, including unmapped invested drafts", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "invested");
    store.setProjectDraftThreadId(projectRef, otherDraftId, { threadId: otherThreadId });

    store.clearProjectDraftThreadId(projectRef);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(otherDraftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("keeps composer drafts when the thread is still mapped by another project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setProjectDraftThreadId(otherProjectRef, sharedDraftId, { threadId });
    store.setPrompt(sharedDraftId, "keep me");

    store.clearProjectDraftThreadId(projectRef);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectRef(otherProjectRef)?.threadId,
    ).toBe(threadId);
    expect(draftByKey(sharedDraftId)?.prompt).toBe("keep me");
  });

  it("does not clear composer drafts for existing server threads during promotion cleanup", () => {
    const store = useComposerDraftStore.getState();
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
    store.setPrompt(threadRef, "keep me");

    markPromotedDraftThreadByRef(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId));

    expect(useComposerDraftStore.getState().getDraftThread(threadRef)).toBeNull();
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe("keep me");
  });

  it("promotes matching thread ids separately for each environment", () => {
    const store = useComposerDraftStore.getState();
    const localThreadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
    const remoteThreadRef = scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, threadId);

    store.setProjectDraftThreadId(projectRef, localDraftId, { threadId });
    store.setPrompt(localDraftId, "local draft");
    store.setProjectDraftThreadId(remoteProjectRef, remoteDraftId, { threadId });
    store.setPrompt(remoteDraftId, "remote draft");

    markPromotedDraftThreadByRef(localThreadRef);

    expect(store.getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(store.getDraftThreadByProjectRef(remoteProjectRef)?.threadId).toBe(threadId);
    expect(store.getDraftThreadByRef(localThreadRef)?.promotedTo).toEqual(localThreadRef);
    expect(store.getDraftThreadByRef(remoteThreadRef)?.promotedTo).toBeNull();
    expect(draftByKey(localDraftId)?.prompt).toBe("local draft");
    expect(draftByKey(remoteDraftId)?.prompt).toBe("remote draft");

    markPromotedDraftThreadByRef(remoteThreadRef);

    expect(store.getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(store.getDraftThreadByProjectRef(remoteProjectRef)).toBeNull();
    expect(store.getDraftThreadByRef(localThreadRef)?.promotedTo).toEqual(localThreadRef);
    expect(store.getDraftThreadByRef(remoteThreadRef)?.promotedTo).toEqual(remoteThreadRef);
    expect(draftByKey(localDraftId)?.prompt).toBe("local draft");
    expect(draftByKey(remoteDraftId)?.prompt).toBe("remote draft");
  });

  it("keeps background submission pending until navigation or failure releases it", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    const ref = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
    const key = scopedThreadKey(ref);
    beginBackgroundDraftSubmissionByRef(ref);
    expect(useComposerDraftStore.getState().backgroundSubmissionThreadKeys[key]).toBe(true);
    clearBackgroundDraftSubmissionByRef(ref);
    expect(useComposerDraftStore.getState().backgroundSubmissionThreadKeys[key]).toBeUndefined();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).not.toBeNull();
    beginBackgroundDraftSubmissionByRef(ref);
    finalizePromotedDraftThreadByRef(ref);
    expect(useComposerDraftStore.getState().backgroundSubmissionThreadKeys[key]).toBeUndefined();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
  });

  it("restores a failed draft without changing the fresh draft", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    const sentDraft = useComposerDraftStore.getState().getDraftSession(draftId)!;
    markPromotedDraftThreadByRef(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId));
    const freshId = DraftId.make("fresh-background-draft");
    store.setProjectDraftThreadId(projectRef, freshId, { threadId: ThreadId.make("fresh-thread") });
    store.setPrompt(freshId, "new work");
    store.setDraftThreadContext(draftId, { branch: "retry-base" });
    restoreFailedDraftThread(draftId, sentDraft, ThreadId.make("retry-thread"));
    store.setPrompt(draftId, "retry work");
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo).toBeNull();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.threadId).toBe(
      "retry-thread",
    );
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.branch).toBe("retry-base");
    expect(draftByKey(freshId)?.prompt).toBe("new work");
    expect(draftByKey(draftId)?.prompt).toBe("retry work");
  });

  it("moves composer edits made during promotion to the canonical thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    markPromotedDraftThreadByRef(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId));
    store.setPrompt(draftId, "typed during setup");

    finalizePromotedDraftThreadByRef(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId));

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe("typed during setup");
  });

  it("finalizes a matching materialized draft even when promotion was not pre-marked", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "promote me");

    finalizePromotedDraftThreadByRef(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId));

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe("promote me");
  });

  it("preserves existing branch and worktree when setProjectDraftThreadId receives undefined", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: "main",
      worktreePath: "/tmp/main-worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
    };
    store.setProjectDraftThreadId(projectRef, draftId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      branch: "main",
      worktreePath: "/tmp/main-worktree",
      envMode: "worktree",
    });
  });

  it("clears branch and worktree but keeps env mode when remapping a draft to another environment", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: "feature/local-only",
      worktreePath: "/tmp/local-worktree",
      envMode: "worktree",
      startFromOrigin: true,
    });

    store.setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), remoteProjectRef, draftId, {
      threadId,
    });

    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: OTHER_TEST_ENVIRONMENT_ID,
      projectId,
      branch: null,
      worktreePath: null,
      envMode: "worktree",
      startFromOrigin: true,
    });
  });

  it("clears stale upload metadata when retargeting a draft to another environment", () => {
    const store = useComposerDraftStore.getState();
    const hydratedFile: ComposerFileAttachment = {
      ...makeFile("file-cross-environment"),
      file: null,
      uploadedAttachmentId: "local-environment-upload",
      uploadEnvironmentId: TEST_ENVIRONMENT_ID,
    };

    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.addFiles(draftId, [hydratedFile]);

    store.setProjectDraftThreadId(remoteProjectRef, draftId, { threadId });

    const file = store.getComposerDraft(draftId)?.files[0];
    expect(file).toMatchObject({
      id: hydratedFile.id,
      file: null,
    });
    expect(file?.uploadedAttachmentId).toBeUndefined();
    expect(file?.uploadEnvironmentId).toBeUndefined();
    expect(file && composerFileNeedsReattach(file)).toBe(true);
  });

  it("rechecks balancing when an empty draft is remapped to another project member", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      environmentSelection: "auto",
      loadBalancedEnvironmentId: TEST_ENVIRONMENT_ID,
    });
    store.setProjectDraftThreadId(remoteProjectRef, draftId, { threadId });
    expect(store.getDraftThread(draftId)).toMatchObject({
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
    });
    store.setDraftThreadContext(draftId, { loadBalancedEnvironmentId: OTHER_TEST_ENVIRONMENT_ID });
    store.setDraftThreadContext(draftId, { projectRef });
    expect(store.getDraftThread(draftId)).toMatchObject({
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
    });
  });

  it("pins manual workspace choices and can return to automatic routing without losing the prompt", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "keep this prompt");
    store.setDraftThreadContext(draftId, {
      projectRef: remoteProjectRef,
      environmentSelection: "auto",
      loadBalancedEnvironmentId: OTHER_TEST_ENVIRONMENT_ID,
    });
    expect(store.getDraftThread(draftId)).toMatchObject({
      environmentId: OTHER_TEST_ENVIRONMENT_ID,
      environmentSelection: "auto",
      loadBalancedEnvironmentId: OTHER_TEST_ENVIRONMENT_ID,
    });
    store.setDraftThreadContext(draftId, { branch: "feature/pinned" });
    expect(store.getDraftThread(draftId)?.environmentSelection).toBe("manual");
    store.setDraftThreadContext(draftId, {
      branch: null,
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
    });
    expect(store.getDraftThread(draftId)).toMatchObject({
      branch: null,
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
    });
    expect(store.getComposerDraft(draftId)?.prompt).toBe("keep this prompt");
  });
});

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

