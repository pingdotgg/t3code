import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import { createEnvironmentThreadShellAtoms } from "@t3tools/client-runtime/state/threads";
import {
  applyShellStreamEvent,
  createEnvironmentSnapshotAtom,
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
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ShellSnapshot,
  type ModelSelection,
  type PreviewAnnotationPayload,
  type ProviderOptionSelection,
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
  restoreFailedDraftThread,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  composerFileNeedsReattach,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
  DraftId,
} from "./composerDraftStore";
import { insertInlineContextReference } from "./lib/composerContextReferences";
import { terminalContextReference, threadContextRecord } from "./lib/composerContextRecords";
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

describe("composerDraftStore addImages", () => {
  const threadId = ThreadId.make("thread-dedupe");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("restores images with matching metadata without replacing unsent bytes", () => {
    const store = useComposerDraftStore.getState();
    const unsent = makeImage({ id: "unsent", previewUrl: "blob:unsent" });
    const restored = {
      ...unsent,
      id: "restored",
      previewUrl: "blob:restored",
      file: new File([new Uint8Array(unsent.sizeBytes).fill(2)], unsent.name, {
        type: unsent.mimeType,
        lastModified: unsent.file.lastModified,
      }),
    };
    store.addImages(threadRef, [unsent]);
    store.addImages(threadRef, [restored, restored], { allowDuplicates: true });

    const images = store.getComposerDraft(threadRef)?.images;
    expect(images?.map((image) => image.id)).toEqual(["unsent", "restored"]);
    expect(images?.[0]?.file).toBe(unsent.file);
    expect(images?.[1]?.file).toBe(restored.file);
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it("deduplicates against existing images across calls by file signature", () => {
    const first = makeImage({
      id: "img-a",
      previewUrl: "blob:a",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 777,
    });
    const duplicateLater = makeImage({
      id: "img-b",
      previewUrl: "blob:b",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 999,
    });

    expect(useComposerDraftStore.getState().addImage(threadRef, first)).toBe(true);
    expect(useComposerDraftStore.getState().addImage(threadRef, duplicateLater)).toBe(false);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.images.map((image) => image.id)).toEqual(["img-a"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:b");
  });
});

describe("composerDraftStore copied attachments", () => {
  beforeEach(resetComposerDraftStore);
  afterEach(() => {
    rememberCopiedComposerAttachments(TEST_ENVIRONMENT_ID, new Map());
    resetComposerDraftStore();
    vi.restoreAllMocks();
  });

  it("keeps unsent image and file bytes usable in another draft after source removal", async () => {
    const source = scopeThreadRef(TEST_ENVIRONMENT_ID, ThreadId.make("copy-source"));
    const target = scopeThreadRef(TEST_ENVIRONMENT_ID, ThreadId.make("copy-target"));
    const image = makeImage({ id: "uploading-image", previewUrl: "blob:source" });
    const file = makeFile("uploading-file");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const store = useComposerDraftStore.getState();
    store.addImages(source, [image]);
    store.addFiles(source, [file]);
    rememberCopiedComposerAttachments(
      TEST_ENVIRONMENT_ID,
      new Map([
        [image.id, image.file],
        [file.id, file.file!],
      ]),
    );

    store.removeImage(source, image.id);
    store.clearComposerContent(source);
    expect(store.getComposerDraft(source)).toBeNull();
    expect(revoke).toHaveBeenCalledWith(image.previewUrl);

    const copiedImage = copiedComposerAttachmentFile(TEST_ENVIRONMENT_ID, image.id);
    const copiedFile = copiedComposerAttachmentFile(TEST_ENVIRONMENT_ID, file.id);
    expect(copiedImage).toBe(image.file);
    expect(copiedFile).toBe(file.file);
    store.addImages(target, [{ ...image, file: copiedImage!, previewUrl: "blob:target" }]);
    store.addFiles(target, [{ ...file, file: copiedFile! }]);
    const draft = store.getComposerDraft(target)!;
    expect([...new Uint8Array(await draft.images[0]!.file.arrayBuffer())]).toEqual([1, 1, 1, 1]);
    expect(await draft.files[0]!.file!.text()).toBe("report");
  });

  it("does not reuse bytes from another environment or a superseded clipboard copy", () => {
    const first = makeImage({ id: "first", previewUrl: "blob:first" });
    const second = makeFile("second");
    rememberCopiedComposerAttachments(TEST_ENVIRONMENT_ID, new Map([[first.id, first.file]]));
    expect(copiedComposerAttachmentFile(OTHER_TEST_ENVIRONMENT_ID, first.id)).toBeUndefined();

    rememberCopiedComposerAttachments(TEST_ENVIRONMENT_ID, new Map([[second.id, second.file!]]));
    expect(copiedComposerAttachmentFile(TEST_ENVIRONMENT_ID, first.id)).toBeUndefined();
    expect(copiedComposerAttachmentFile(TEST_ENVIRONMENT_ID, second.id)).toBe(second.file);

    rememberCopiedComposerAttachments(TEST_ENVIRONMENT_ID, new Map());
    expect(copiedComposerAttachmentFile(TEST_ENVIRONMENT_ID, second.id)).toBeUndefined();
  });
});

describe("composerDraftStore unsent draft marker", () => {
  const threadId = ThreadId.make("thread-unsent-marker");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  // regression: #11338 rewind locks are session-only and must not survive a reload
  it("does not persist active rewind locks", () => {
    const threadKey = threadKeyFor(threadId, TEST_ENVIRONMENT_ID);
    useComposerDraftStore.setState({ rewindingThreadKeys: new Set([threadKey]) });

    expect(useComposerDraftStore.getState().rewindingThreadKeys.has(threadKey)).toBe(true);
    expect(partializeComposerDraftStoreState(useComposerDraftStore.getState())).not.toHaveProperty(
      "rewindingThreadKeys",
    );
  });
});

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

describe("composerDraftStore terminal contexts", () => {
  const threadId = ThreadId.make("thread-dedupe");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("deduplicates identical terminal contexts by selection signature", () => {
    const first = makeTerminalContext({ id: "ctx-1" });
    const duplicate = makeTerminalContext({ id: "ctx-2" });

    useComposerDraftStore.getState().addTerminalContexts(threadRef, [first, duplicate]);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-1"]);
  });

  it("inserts terminal contexts at the requested inline prompt position", () => {
    const first = makeTerminalContext({ id: "ctx-1" });
    const second = makeTerminalContext({
      id: "ctx-2",
      terminalLabel: "Terminal 2",
      lineStart: 9,
      lineEnd: 10,
    });
    const firstInsertion = insertInlineContextReference(
      "alpha beta",
      6,
      terminalContextReference(first),
    );
    const secondInsertion = insertInlineContextReference(
      firstInsertion.prompt,
      0,
      terminalContextReference(second),
    );

    expect(
      useComposerDraftStore
        .getState()
        .insertTerminalContext(threadRef, firstInsertion.prompt, first, 0),
    ).toBe(true);
    expect(
      useComposerDraftStore
        .getState()
        .insertTerminalContext(threadRef, secondInsertion.prompt, second, 0),
    ).toBe(true);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.prompt).toBe(
      `${formatTerminalContextReference(second)} alpha ${formatTerminalContextReference(first)} beta`,
    );
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-2", "ctx-1"]);
  });

  it("sanitizes malformed persisted drafts during merge", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: "",
            attachments: "not-an-array",
            terminalContexts: "not-an-array",
            provider: "bogus-provider",
            modelOptions: "not-an-object",
          },
        },
        draftThreadsByThreadId: "not-an-object",
        projectDraftThreadIdByProjectKey: "not-an-object",
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadKey[threadKeyFor(threadId)]).toBeUndefined();
    expect(mergedState.draftThreadsByThreadKey).toEqual({});
    expect(mergedState.logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual({});
  });
});

describe("composerDraftStore context persistence", () => {
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, ThreadId.make("context-persistence"));
  const annotation: PreviewAnnotationPayload = {
    id: "retry-note",
    pageUrl: "http://localhost:3000/checkout",
    pageTitle: "Checkout",
    comment: "Keep the cart after a failed payment",
    elements: [],
    regions: [{ id: "error-region", rect: { x: 10, y: 20, width: 100, height: 50 } }],
    strokes: [],
    styleChanges: [],
    screenshot: null,
    createdAt: "2026-09-06T10:00:00.000Z",
  };

  beforeEach(resetComposerDraftStore);

  it("preserves snapshots and inline positions through repeated persistence and hydration", () => {
    const terminal = {
      ...makeTerminalContext({ id: "checkout-console" }),
      threadId: threadRef.threadId,
    };
    const store = useComposerDraftStore.getState();
    store.addTerminalContext(threadRef, terminal);
    store.addPreviewAnnotation(threadRef, annotation);
    const terminalLink = formatTerminalContextReference(terminal);
    const prompt = `Inspect ${terminalLink}. Apply [Retry note](t3-context://v1/preview-annotation/preview-annotation_retry-note). Compare ${terminalLink} again.`;
    store.setPrompt(threadRef, prompt);
    let state = useComposerDraftStore.getState();
    const merge = useComposerDraftStore.persist.getOptions().merge!;

    for (let reload = 0; reload < 3; reload++) {
      state = merge(
        JSON.parse(JSON.stringify(partializeComposerDraftStoreState(state))),
        useComposerDraftStore.getInitialState(),
      );
      const draft = state.draftsByThreadKey[scopedThreadKey(threadRef)];
      expect(draft?.prompt).toBe(prompt);
      expect(draft?.terminalContexts).toEqual([terminal]);
      expect(draft?.previewAnnotations).toEqual([annotation]);
    }
  });
});

describe("composerDraftStore thread contexts", () => {
  const threadId = ThreadId.make("thread-with-context");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
  const attached = threadContextRecord(
    scopeThreadRef(TEST_ENVIRONMENT_ID, ThreadId.make("attached-thread")),
    "Fix [login] flow",
  );

  beforeEach(resetComposerDraftStore);

  it("attaches once per thread, appends one chip, and survives persistence", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "Compare with");
    store.addThreadContexts(threadRef, [attached]);
    store.addThreadContexts(threadRef, [attached, { ...attached, title: "renamed" }]);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.threadContexts).toEqual([attached]);
    expect(attached.label).toBe("Fix login flow");
    expect(draft?.prompt).toBe(
      `Compare with [${attached.label}](t3-context://v1/thread/${attached.contextId}) `,
    );

    const merge = useComposerDraftStore.persist.getOptions().merge!;
    const hydrated = merge(
      JSON.parse(
        JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState())),
      ),
      useComposerDraftStore.getInitialState(),
    );
    expect(hydrated.draftsByThreadKey[scopedThreadKey(threadRef)]?.threadContexts).toEqual([
      attached,
    ]);
    expect(hydrated.draftsByThreadKey[scopedThreadKey(threadRef)]?.prompt).toBe(draft?.prompt);
  });
});

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
  const { titleRegenerationFailure: _failure, ...fixtureThread } =
    makeThreadProjectionFixture().thread;
  const thread: OrchestrationV2ThreadShell = {
    ...fixtureThread,
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
    snapshot: Option.some(initialSnapshot),
    status: initialStatus,
    error: Option.none(),
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

  it("does not clear other provider options when setting options for a single provider", () => {
    const store = useComposerDraftStore.getState();

    store.setModelOptions(
      threadRef,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    store.setModelOptions(threadRef, providerModelOptions({ codex: { reasoningEffort: "xhigh" } }));

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.modelSelectionByProvider[CODEX_INSTANCE]?.options).toEqual(
      createModelSelection(CODEX_INSTANCE, "gpt-5.4", toSelections({ reasoningEffort: "xhigh" }))
        .options,
    );
    expect(draft?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE]?.options).toEqual(
      createModelSelection(
        CLAUDE_AGENT_INSTANCE,
        "claude-opus-4-6",
        toSelections({ effort: "max" }),
      ).options,
    );
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
  });
});

describe("composerDraftStore per-model sticky options", () => {
  const threadId = ThreadId.make("thread-per-model-options");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("remembers sticky options per model and restores them on model switch", () => {
    const store = useComposerDraftStore.getState();

    store.setProviderModelOptions(
      threadRef,
      CODEX_DRIVER,
      toSelections({ reasoningEffort: "xhigh" }),
      { instanceId: CODEX_INSTANCE, model: "gpt-5.3-codex", persistSticky: true },
    );
    store.setProviderModelOptions(
      threadRef,
      CODEX_DRIVER,
      toSelections({ reasoningEffort: "high" }),
      { instanceId: CODEX_INSTANCE, model: "gpt-5.4", persistSticky: true },
    );

    expect(useComposerDraftStore.getState().stickyOptionsByModelByProvider[CODEX_INSTANCE]).toEqual(
      {
        "gpt-5.3-codex": toSelections({ reasoningEffort: "xhigh" }),
        "gpt-5.4": toSelections({ reasoningEffort: "high" }),
      },
    );
  });

  it("seeds per-model memory from a persisted sticky selection on upgrade", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => Pick<
          ReturnType<typeof useComposerDraftStore.getState>,
          "stickyModelSelectionByProvider" | "stickyOptionsByModelByProvider"
        >;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        stickyModelSelectionByProvider: {
          [CODEX_INSTANCE]: {
            instanceId: CODEX_INSTANCE,
            model: "gpt-5.3-codex",
            options: [{ id: "reasoningEffort", value: "low" }],
          },
        },
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.stickyOptionsByModelByProvider).toEqual({
      [CODEX_INSTANCE]: { "gpt-5.3-codex": [{ id: "reasoningEffort", value: "low" }] },
    });
  });
});

describe("composerDraftStore sticky composer settings", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("preserves sticky provider options when model selection omits options", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection(CURSOR_DRIVER, "composer-2", {
        fastMode: false,
      }),
    );
    store.setStickyModelSelection(modelSelection(CURSOR_DRIVER, "composer-2.5"));

    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(
      modelSelection(CURSOR_DRIVER, "composer-2.5", {
        fastMode: false,
      }),
    );
  });

  it("applies sticky activeProvider to new drafts", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.make("thread-sticky-active-provider");
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

    store.setStickyModelSelection(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"));
    store.applyStickyState(threadRef);

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toMatchObject({
      modelSelectionByProvider: {
        claudeAgent: modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"),
      },
      activeProvider: "claudeAgent",
    });
  });

  it("replaces a non-explicit stale model and its options with sticky state", () => {
    const store = useComposerDraftStore.getState();
    const draftId = DraftId.make("draft-stale-sticky-seed");

    store.setModelSelection(
      draftId,
      modelSelection(CODEX_DRIVER, "stale-model", { reasoningEffort: "low" }),
    );
    store.setStickyModelSelection(
      modelSelection(CODEX_DRIVER, "sticky-model", { reasoningEffort: "xhigh" }),
    );
    store.applyStickyState(draftId);

    expect(draftByKey(draftId)).toMatchObject({
      activeProvider: CODEX_INSTANCE,
      modelSelectionByProvider: {
        [CODEX_INSTANCE]: modelSelection(CODEX_DRIVER, "sticky-model", {
          reasoningEffort: "xhigh",
        }),
      },
    });
  });

  // regression: #6011 a stale seeded model overrode the project default
  it("clears a non-explicit stale model when there is no sticky state", () => {
    const store = useComposerDraftStore.getState();
    const draftId = DraftId.make("draft-stale-without-sticky");

    store.setModelSelection(draftId, modelSelection(CODEX_DRIVER, "stale-model"));
    store.applyStickyState(draftId);

    expect(draftByKey(draftId)).toBeUndefined();
  });
});

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

describe("createDeferredStorage", () => {
  const serialize = vi.fn((value: string) => `s:${value}`);

  beforeEach(() => {
    vi.useFakeTimers();
    serialize.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removeItem cancels a pending setItem write", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    storage.removeItem("key");

    vi.advanceTimersByTime(300);
    expect(serialize).not.toHaveBeenCalled();
    expect(base.setItem).not.toHaveBeenCalled();
    expect(base.removeItem).toHaveBeenCalledWith("key");
  });

  it("flush serializes and writes the pending value immediately", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    storage.flush();
    expect(base.setItem).toHaveBeenCalledWith("key", "s:v1");

    vi.advanceTimersByTime(300);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledTimes(1);
  });
});

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

describe("composerDraftStore attachment references", () => {
  const threadId = ThreadId.make("thread-attachment-refs");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
  const fileLink = "[notes.txt](t3-context://v1/file/file_file-1)";
  const imageLink = "[shot.png](t3-context://v1/image/image_img-1)";

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("reports which attachments it accepted so only those get chips", () => {
    const store = useComposerDraftStore.getState();
    const file = {
      type: "file" as const,
      id: "file-1",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      file: null,
      uploadedAttachmentId: "p",
      uploadEnvironmentId: TEST_ENVIRONMENT_ID,
    };
    expect(store.addFiles(threadRef, [file])).toEqual(["file-1"]);
    expect(store.addFiles(threadRef, [{ ...file, id: "file-2" }])).toEqual([]);
    const image = makeImage({ id: "img-1", previewUrl: "blob:img-1", name: "shot.png" });
    expect(store.addImages(threadRef, [image])).toEqual(["img-1"]);
    expect(
      store.addImages(threadRef, [
        makeImage({ id: "img-2", previewUrl: "blob:img-2", name: "shot.png" }),
      ]),
    ).toEqual([]);
  });

  it("strips references when an image or file is removed", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, `see ${imageLink} and ${fileLink} ok`);
    store.addImages(threadRef, [
      makeImage({ id: "img-1", previewUrl: "blob:img-1", name: "shot.png" }),
    ]);
    store.addFiles(threadRef, [
      {
        type: "file",
        id: "file-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        file: null,
        uploadedAttachmentId: "pending-1",
        uploadEnvironmentId: TEST_ENVIRONMENT_ID,
      },
    ]);
    store.removeImage(threadRef, "img-1");
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe(`see and ${fileLink} ok`);
    store.removeFile(threadRef, "file-1");
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe("see and ok");
  });

  it("moves a needs-reattach marker's chip to the re-picked file", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "see [notes.txt](t3-context://v1/file/file_marker-1) ok");
    store.addFiles(threadRef, [
      {
        type: "file",
        id: "marker-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        file: null,
      },
    ]);
    const acceptedIds = store.addFiles(threadRef, [
      {
        type: "file",
        id: "fresh-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        file: new File(["abc"], "notes.txt", { type: "text/plain" }),
      },
    ]);
    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(acceptedIds).toEqual([]);
    expect(draft?.files.map((file) => file.id)).toEqual(["fresh-1"]);
    expect(draft?.prompt).toBe("see [notes.txt](t3-context://v1/file/file_fresh-1) ok");
  });

  it.each(["old.file:1", "file-1"])(
    "rewrites persisted attachment references before removal: %s",
    (id) => {
      const merged = useComposerDraftStore.persist.getOptions().merge!(
        {
          draftsByThreadKey: {
            [threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]: {
              prompt: `before [notes.txt](t3-context://v1/file/${id}) after`,
              attachments: [],
              files: [{ id, name: "notes.txt", mimeType: "text/plain", sizeBytes: 3 }],
            },
          },
        },
        useComposerDraftStore.getInitialState(),
      );
      useComposerDraftStore.setState(merged);
      const draft = draftFor(threadId, TEST_ENVIRONMENT_ID)!;
      expect(draft.prompt.match(/t3-context:/g)).toHaveLength(1);
      expect(draft.prompt).not.toContain(`/file/${id})`);
      useComposerDraftStore.getState().removeFile(threadRef, id);
      expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe("before after");
    },
  );

  it("appends chips for persisted files that predate references", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: "old",
            attachments: [],
            files: [{ id: "file-1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 3 }],
          },
        },
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectKey: {},
      },
      useComposerDraftStore.getInitialState(),
    );
    expect(mergedState.draftsByThreadKey[threadKeyFor(threadId)]?.prompt).toBe(`old ${fileLink} `);
  });

  it("migrates legacy image references without doubling their image marker", () => {
    const merged = useComposerDraftStore.persist.getOptions().merge!(
      {
        draftsByThreadKey: {
          [threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]: {
            prompt: "see ![shot.png](t3-context://v1/image/img-1) after",
            attachments: [
              {
                id: "img-1",
                name: "shot.png",
                mimeType: "image/png",
                sizeBytes: 1,
                dataUrl: "data:image/png;base64,YQ==",
              },
            ],
          },
        },
      },
      useComposerDraftStore.getInitialState(),
    );
    expect(merged.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]?.prompt).toBe(
      "see ![shot.png](t3-context://v1/image/image_img-1) after",
    );
  });

  it("preserves canonical references when another producer ID matches their namespace", () => {
    const prompt =
      "![x.png](t3-context://v1/image/image_x) ![image_x.png](t3-context://v1/image/image_image_x)";
    const merged = useComposerDraftStore.persist.getOptions().merge!(
      {
        draftsByThreadKey: {
          [threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]: {
            prompt,
            attachments: ["x", "image_x"].map((id) => ({
              id,
              name: `${id}.png`,
              mimeType: "image/png",
              sizeBytes: 1,
              dataUrl: "data:image/png;base64,YQ==",
            })),
          },
        },
      },
      useComposerDraftStore.getInitialState(),
    );
    expect(merged.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]?.prompt).toBe(
      prompt,
    );
  });
});
