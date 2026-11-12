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





describe("composerDraftStore file attachments", () => {
  const threadId = ThreadId.make("thread-files");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("persists uploaded file references without including file contents", () => {
    const store = useComposerDraftStore.getState();
    store.addFiles(threadRef, [
      { ...makeFile("file-1"), source: { _tag: "pasted-text" as const } },
    ]);
    store.setFileUpload(threadRef, "file-1", TEST_ENVIRONMENT_ID, "pending-report-pdf");

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const options = persistApi.getOptions();
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());

    expect(persisted.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]?.files).toEqual(
      [
        {
          id: "file-1",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 6,
          attachmentId: "pending-report-pdf",
          environmentId: TEST_ENVIRONMENT_ID,
          source: { _tag: "pasted-text" },
        },
      ],
    );

    const hydrated = options.merge(persisted, useComposerDraftStore.getState());
    expect(hydrated.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]?.files).toEqual([
      {
        type: "file",
        id: "file-1",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 6,
        file: null,
        uploadedAttachmentId: "pending-report-pdf",
        uploadEnvironmentId: TEST_ENVIRONMENT_ID,
        source: { _tag: "pasted-text" },
      },
    ]);
  });

  it("persists a pending file as a needs-reattach marker instead of dropping it", () => {
    const store = useComposerDraftStore.getState();
    store.addFiles(threadRef, [makeFile("file-pending")]);

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const options = persistApi.getOptions();
    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());

    expect(persisted.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]?.files).toEqual(
      [
        {
          id: "file-pending",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 6,
        },
      ],
    );

    const hydrated = options.merge(persisted, useComposerDraftStore.getState());
    const hydratedFiles =
      hydrated.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]?.files;
    expect(hydratedFiles).toEqual([
      {
        type: "file",
        id: "file-pending",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 6,
        file: null,
      },
    ]);
    expect(hydratedFiles?.every(composerFileNeedsReattach)).toBe(true);
  });

  it("marks only the matching byte-less upload as missing", () => {
    const store = useComposerDraftStore.getState();
    const hydrated: ComposerFileAttachment = {
      ...makeFile("file-hydrated"),
      file: null,
      uploadedAttachmentId: "pending-old",
      uploadEnvironmentId: TEST_ENVIRONMENT_ID,
    };
    const local: ComposerFileAttachment = {
      ...makeFile("file-local"),
      name: "local.txt",
      mimeType: "text/plain",
    };
    store.addFiles(threadRef, [hydrated, local]);
    store.setFileUpload(threadRef, hydrated.id, TEST_ENVIRONMENT_ID, "pending-new");
    store.setFileUpload(threadRef, local.id, TEST_ENVIRONMENT_ID, "pending-local");

    expect(
      store.markFileUploadMissing(threadRef, hydrated.id, OTHER_TEST_ENVIRONMENT_ID, "pending-new"),
    ).toBe(false);
    expect(
      store.markFileUploadMissing(threadRef, hydrated.id, TEST_ENVIRONMENT_ID, "pending-old"),
    ).toBe(false);
    expect(
      store.markFileUploadMissing(threadRef, local.id, TEST_ENVIRONMENT_ID, "pending-local"),
    ).toBe(false);

    expect(store.getComposerDraft(threadRef)?.files).toMatchObject([
      {
        id: hydrated.id,
        uploadedAttachmentId: "pending-new",
        uploadEnvironmentId: TEST_ENVIRONMENT_ID,
      },
      {
        id: local.id,
        file: local.file,
        uploadedAttachmentId: "pending-local",
        uploadEnvironmentId: TEST_ENVIRONMENT_ID,
      },
    ]);

    expect(
      store.markFileUploadMissing(threadRef, hydrated.id, TEST_ENVIRONMENT_ID, "pending-new"),
    ).toBe(true);
    const marker = store.getComposerDraft(threadRef)?.files[0];
    expect(marker && composerFileNeedsReattach(marker)).toBe(true);
    expect(marker?.uploadedAttachmentId).toBeUndefined();
    expect(marker?.uploadEnvironmentId).toBeUndefined();
  });

  it("enforces the combined file and image limit across separate updates", () => {
    const store = useComposerDraftStore.getState();
    const images = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 }, (_, index) =>
      makeImage({
        id: `image-${index}`,
        name: `image-${index}.png`,
        previewUrl: `blob:image-${index}`,
      }),
    );
    store.addImages(threadRef, images);
    store.addFiles(threadRef, [
      makeFile("file-accepted"),
      { ...makeFile("file-overflow"), name: "other.pdf" },
    ]);
    expect(
      store.addImage(
        threadRef,
        makeImage({ id: "image-overflow", name: "overflow.png", previewUrl: "blob:overflow" }),
      ),
    ).toBe(false);

    const draft = store.getComposerDraft(threadRef);
    expect(draft?.images).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1);
    expect(draft?.files.map((file) => file.id)).toEqual(["file-accepted"]);
  });

  it("reattaches a DNG with an older generic-MIME marker at attachment capacity", () => {
    const store = useComposerDraftStore.getState();
    const file = new File(["raw"], "photo.DNG", { type: "image/x-adobe-dng" });
    const marker: ComposerFileAttachment = {
      type: "file",
      id: "dng-marker",
      name: file.name,
      mimeType: "application/octet-stream",
      sizeBytes: file.size,
      file: null,
    };
    store.addFiles(threadRef, [marker]);
    store.addImages(
      threadRef,
      Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 }, (_, index) =>
        makeImage({
          id: `image-${index}`,
          name: `image-${index}.png`,
          previewUrl: `blob:image-${index}`,
        }),
      ),
    );

    const repicked: ComposerFileAttachment = {
      ...marker,
      id: "dng-repicked",
      mimeType: file.type,
      file,
    };
    store.addFiles(threadRef, [repicked]);

    const files = store.getComposerDraft(threadRef)?.files;
    expect(files).toEqual([repicked]);
    expect(files?.some(composerFileNeedsReattach)).toBe(false);
  });

  it("replaces a needs-reattach marker when the same file is picked again", () => {
    const store = useComposerDraftStore.getState();
    const marker: ComposerFileAttachment = { ...makeFile("file-marker"), file: null };
    store.addFiles(threadRef, [marker]);
    expect(store.getComposerDraft(threadRef)?.files.every(composerFileNeedsReattach)).toBe(true);

    const repicked = makeFile("file-repicked");
    store.addFiles(threadRef, [repicked]);

    const files = store.getComposerDraft(threadRef)?.files;
    expect(files?.map((file) => file.id)).toEqual(["file-repicked"]);
    expect(files?.[0]?.file).not.toBeNull();
    expect(files?.some(composerFileNeedsReattach)).toBe(false);
  });
});

