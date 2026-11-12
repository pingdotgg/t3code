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





describe("composerDraftStore inline context references", () => {
  const threadId = ThreadId.make("thread-inline-context");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
  const reviewComment = {
    id: "rc-1",
    sectionId: "file:a/b.ts",
    sectionTitle: "File comment",
    filePath: "a/b.ts",
    startIndex: 3,
    endIndex: 3,
    rangeLabel: "L4",
    text: "Why?",
    diff: "const x = 1;",
  };
  const reviewLink = "[b.ts L4](t3-context://v1/review-comment/review-comment_rc-1)";
  const annotation = {
    id: "ann-1",
    pageUrl: "http://localhost:3000/",
    pageTitle: "Home",
    comment: "Bigger",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const annotationLink = "[Bigger](t3-context://v1/preview-annotation/preview-annotation_ann-1)";

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("appends a link when a review comment is added and strips it on removal", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "look");
    store.addReviewComment(threadRef, reviewComment);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe(`look ${reviewLink} `);
    store.addReviewComment(threadRef, { ...reviewComment, text: "edited" });
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe(`look ${reviewLink} `);
    store.removeReviewComment(threadRef, "rc-1");
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe("look");
  });

  it("keeps bulk-set review records and their inline references in sync", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "Explain this pull request.");
    store.setReviewComments(threadRef, [reviewComment]);

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe(
      `Explain this pull request. ${reviewLink} `,
    );
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.reviewComments).toEqual([reviewComment]);

    store.setReviewComments(threadRef, []);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe("Explain this pull request.");
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.reviewComments).toEqual([]);
  });

  it("hands new review comments to a registered caret handler instead of appending", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "look");
    const seen: string[] = [];
    store.setContextInsertionHandler(threadRef, (references) => {
      seen.push(...references.map((reference) => reference.contextId));
      return true;
    });
    store.addReviewComment(threadRef, reviewComment);
    expect(seen).toEqual(["review-comment_rc-1"]);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe("look");
    store.setContextInsertionHandler(threadRef, null);
    store.addReviewComment(threadRef, { ...reviewComment, id: "rc-2" });
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe(
      "look [b.ts L4](t3-context://v1/review-comment/review-comment_rc-2) ",
    );
  });

  it("does not overwrite a prompt update made by the caret handler", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "before after");
    store.setContextInsertionHandler(threadRef, (references) => {
      const reference = references[0];
      if (!reference) return false;
      useComposerDraftStore
        .getState()
        .setPrompt(
          threadRef,
          `before [${reference.label}](t3-context://v1/${reference.kind}/${reference.contextId}) after`,
        );
      return true;
    });

    store.addReviewComment(threadRef, reviewComment);

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe(`before ${reviewLink} after`);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.reviewComments).toEqual([reviewComment]);
    store.setContextInsertionHandler(threadRef, null);
  });

  it("keeps links for retained context when clearing text and attachments", () => {
    const store = useComposerDraftStore.getState();
    store.addReviewComment(threadRef, reviewComment);
    store.addPreviewAnnotation(threadRef, annotation);
    store.clearComposerPromptAndImages(threadRef);
    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.prompt).toContain(reviewLink);
    expect(draft?.prompt).toContain(annotationLink);
    expect(draft?.reviewComments).toEqual([reviewComment]);
    expect(draft?.previewAnnotations).toEqual([annotation]);
  });
});

