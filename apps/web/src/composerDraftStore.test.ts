import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import {
  defaultInstanceIdForDriver,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ThreadId,
  type ModelSelection,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";

// The composer draft's `modelSelectionByProvider` and
// `stickyModelSelectionByProvider` maps are keyed by `ProviderInstanceId`
// in production; these aliases keep the legacy-key migration tests concise.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  clearComposerDraftsEnvironment,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThread,
  markPromotedDraftThreadByRef,
  markPromotedDraftThreads,
  markPromotedDraftThreadsByRef,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  composerFileNeedsReattach,
  useComposerDraftStore,
  DraftId,
} from "./composerDraftStore";
import { removeLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
} from "./lib/terminalContext";
import { createDebouncedStorage } from "./lib/storage";

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
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
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

describe("composerDraftStore assistant citations", () => {
  beforeEach(resetComposerDraftStore);
  afterEach(resetComposerDraftStore);

  it("keeps quotes, comments, and remote source IDs through persistence and removes them on clear", () => {
    const threadId = ThreadId.make("citation-draft");
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
    const citation = {
      version: 1 as const,
      environmentId: EnvironmentId.make("remote-source"),
      threadId: ThreadId.make("source-thread"),
      messageId: MessageId.make("source-message"),
      text: "Preserve the selected text after reload.",
      comment: "Why is this important?\nPlease show an example.",
      start: 12,
      end: 52,
      prefix: "Before. ",
      suffix: " After.",
    };
    const prompt = `Explain ${serializeAssistantCitation(citation)} further.`;
    useComposerDraftStore.getState().setPrompt(threadRef, prompt);
    const options = useComposerDraftStore.persist.getOptions();
    const saved = JSON.parse(
      JSON.stringify(options.partialize!(useComposerDraftStore.getState())),
    ) as unknown;
    resetComposerDraftStore();
    const hydrated = options.merge!(saved, useComposerDraftStore.getState());
    useComposerDraftStore.setState(hydrated);
    const restored = draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt ?? "";
    expect(restored).toBe(prompt);
    expect(collectAssistantCitations(restored).map((entry) => entry.citation)).toEqual([citation]);
    useComposerDraftStore.getState().clearComposerContent(threadRef);
    expect(
      collectAssistantCitations(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt ?? ""),
    ).toEqual([]);
  });
});

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

  it("deduplicates identical images in one batch by file signature", () => {
    const first = makeImage({
      id: "img-1",
      previewUrl: "blob:first",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });
    const duplicate = makeImage({
      id: "img-2",
      previewUrl: "blob:duplicate",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });

    useComposerDraftStore.getState().addImages(threadRef, [first, duplicate]);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.images.map((image) => image.id)).toEqual(["img-1"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:duplicate");
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

    useComposerDraftStore.getState().addImage(threadRef, first);
    useComposerDraftStore.getState().addImage(threadRef, duplicateLater);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.images.map((image) => image.id)).toEqual(["img-a"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:b");
  });

  it("does not revoke blob URLs that are still used by an accepted duplicate image", () => {
    const first = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });
    const duplicateSameUrl = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });

    useComposerDraftStore.getState().addImages(threadRef, [first, duplicateSameUrl]);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.images.map((image) => image.id)).toEqual(["img-shared"]);
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:shared");
  });
});

describe("composerDraftStore clearComposerContent", () => {
  const threadId = ThreadId.make("thread-clear");
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

  it("does not revoke blob preview URLs when clearing composer content", () => {
    const first = makeImage({
      id: "img-optimistic",
      previewUrl: "blob:optimistic",
    });
    useComposerDraftStore.getState().addImage(threadRef, first);

    useComposerDraftStore.getState().clearComposerContent(threadRef);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft).toBeUndefined();
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:optimistic");
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
    store.addFiles(threadRef, [makeFile("file-1")]);
    store.setFileUpload(threadRef, "file-1", TEST_ENVIRONMENT_ID, "pending-report-pdf");

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const options = persistApi.getOptions();
    const persisted = options.partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey: Record<string, { files?: Array<Record<string, unknown>> }>;
    };

    expect(persisted.draftsByThreadKey[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]?.files).toEqual(
      [
        {
          id: "file-1",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 6,
          attachmentId: "pending-report-pdf",
          environmentId: TEST_ENVIRONMENT_ID,
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
      },
    ]);
  });

  it("persists a pending file as a needs-reattach marker instead of dropping it", () => {
    const store = useComposerDraftStore.getState();
    // No setFileUpload: the upload never finished, so there is no attachment
    // id and the File handle cannot serialize.
    store.addFiles(threadRef, [makeFile("file-pending")]);

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const options = persistApi.getOptions();
    const persisted = options.partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey: Record<string, { files?: Array<Record<string, unknown>> }>;
    };

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

  it("removes generic files when the composer is cleared", () => {
    const store = useComposerDraftStore.getState();
    store.addFiles(threadRef, [makeFile("file-clear")]);

    store.clearComposerContent(threadRef);

    expect(store.getComposerDraft(threadRef)).toBeNull();
  });

  it("removes generic files when a prompt is moved into the stash", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadRef, "Review the report");
    store.addFiles(threadRef, [makeFile("file-stash")]);

    store.clearComposerPromptAndImages(threadRef);

    expect(store.getComposerDraft(threadRef)).toBeNull();
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
    store.addImages(threadRef, [
      makeImage({ id: "image-overflow", name: "overflow.png", previewUrl: "blob:overflow" }),
    ]);

    const draft = store.getComposerDraft(threadRef);
    expect(draft?.images).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1);
    expect(draft?.files.map((file) => file.id)).toEqual(["file-accepted"]);
  });

  it("replaces a needs-reattach marker when the same file is picked again", () => {
    const store = useComposerDraftStore.getState();
    // A hydrated marker: same metadata as the original pick, no bytes and no
    // server-side upload.
    const marker: ComposerFileAttachment = { ...makeFile("file-marker"), file: null };
    store.addFiles(threadRef, [marker]);
    expect(store.getComposerDraft(threadRef)?.files.every(composerFileNeedsReattach)).toBe(true);

    // Following the "Attach again" instruction produces a fresh id with the
    // exact metadata the dedup key hashes.
    const repicked = makeFile("file-repicked");
    store.addFiles(threadRef, [repicked]);

    const files = store.getComposerDraft(threadRef)?.files;
    expect(files?.map((file) => file.id)).toEqual(["file-repicked"]);
    expect(files?.[0]?.file).not.toBeNull();
    expect(files?.some(composerFileNeedsReattach)).toBe(false);
  });

  it("replaces a legacy video marker after its MIME type is normalized", () => {
    const store = useComposerDraftStore.getState();
    const marker: ComposerFileAttachment = {
      type: "file",
      id: "file-marker",
      name: "clip.mkv",
      mimeType: "application/octet-stream",
      sizeBytes: 6,
      file: null,
    };
    store.addFiles(threadRef, [marker]);

    const file = new File(["report"], marker.name, { type: "video/x-matroska" });
    const repicked: ComposerFileAttachment = {
      type: "file",
      id: "file-repicked",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
    };
    store.addFiles(threadRef, [repicked, { ...repicked, id: "file-repicked-duplicate" }]);

    const files = store.getComposerDraft(threadRef)?.files;
    expect(files?.map((entry) => entry.id)).toEqual(["file-repicked"]);
    expect(files?.some(composerFileNeedsReattach)).toBe(false);
  });

  it("replaces a needs-reattach marker with a stash-restored uploaded file", () => {
    const store = useComposerDraftStore.getState();
    const marker: ComposerFileAttachment = { ...makeFile("file-marker"), file: null };
    store.addFiles(threadRef, [marker]);
    expect(store.getComposerDraft(threadRef)?.files.every(composerFileNeedsReattach)).toBe(true);

    // A stash restore carries a finished server-side upload instead of bytes.
    // Matching metadata must replace the marker, not be dropped as a
    // duplicate: the marker cannot send, and the restored ids are the only
    // valid copy.
    const restored: ComposerFileAttachment = {
      ...makeFile("file-restored"),
      file: null,
      uploadedAttachmentId: "pending-stash-pdf",
      uploadEnvironmentId: TEST_ENVIRONMENT_ID,
    };
    store.addFiles(threadRef, [restored]);

    const files = store.getComposerDraft(threadRef)?.files;
    expect(files?.map((file) => file.id)).toEqual(["file-restored"]);
    expect(files?.[0]?.uploadedAttachmentId).toBe("pending-stash-pdf");
    expect(files?.[0]?.uploadEnvironmentId).toBe(TEST_ENVIRONMENT_ID);
    expect(files?.some(composerFileNeedsReattach)).toBe(false);
  });

  it("still dedupes a re-pick against a file that does not need reattaching", () => {
    const store = useComposerDraftStore.getState();
    store.addFiles(threadRef, [makeFile("file-original")]);

    store.addFiles(threadRef, [makeFile("file-duplicate")]);

    expect(store.getComposerDraft(threadRef)?.files.map((file) => file.id)).toEqual([
      "file-original",
    ]);
  });

  it("keeps same-name videos with different MIME types", () => {
    const store = useComposerDraftStore.getState();
    const mp4 = new File(["report"], "clip", { type: "video/mp4" });
    const webm = new File(["report"], "clip", { type: "video/webm" });

    store.addFiles(threadRef, [
      {
        type: "file",
        id: "video-mp4",
        name: mp4.name,
        mimeType: mp4.type,
        sizeBytes: mp4.size,
        file: mp4,
      },
      {
        type: "file",
        id: "video-webm",
        name: webm.name,
        mimeType: webm.type,
        sizeBytes: webm.size,
        file: webm,
      },
    ]);

    expect(store.getComposerDraft(threadRef)?.files.map((file) => file.id)).toEqual([
      "video-mp4",
      "video-webm",
    ]);
  });

  it("keeps the remaining file slot available after a duplicate is skipped", () => {
    const store = useComposerDraftStore.getState();
    store.addImages(
      threadRef,
      Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 2 }, (_, index) =>
        makeImage({
          id: `image-${index}`,
          name: `image-${index}.png`,
          previewUrl: `blob:image-${index}`,
        }),
      ),
    );
    store.addFiles(threadRef, [makeFile("file-original")]);
    store.addFiles(threadRef, [
      makeFile("file-duplicate"),
      { ...makeFile("file-unique"), name: "unique.pdf" },
    ]);

    expect(store.getComposerDraft(threadRef)?.files.map((file) => file.id)).toEqual([
      "file-original",
      "file-unique",
    ]);
  });
});

describe("composerDraftStore syncPersistedAttachments", () => {
  const threadId = ThreadId.make("thread-sync-persisted");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  afterEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
  });

  it("treats malformed persisted draft storage as empty", async () => {
    const image = makeImage({
      id: "img-persisted",
      previewUrl: "blob:persisted",
    });
    useComposerDraftStore.getState().addImage(threadRef, image);
    setLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      {
        version: 2,
        state: {
          draftsByThreadId: {
            [threadId]: {
              attachments: "not-an-array",
            },
          },
        },
      },
      Schema.Unknown,
    );

    useComposerDraftStore.getState().syncPersistedAttachments(threadRef, [
      {
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: image.previewUrl,
      },
    ]);
    await Promise.resolve();

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.persistedAttachments).toEqual([]);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.nonPersistedImageIds).toEqual([image.id]);
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

  it("clears terminal contexts when clearing composer content", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadRef, makeTerminalContext({ id: "ctx-1" }));

    useComposerDraftStore.getState().clearComposerContent(threadRef);

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("inserts terminal contexts at the requested inline prompt position", () => {
    const firstInsertion = insertInlineTerminalContextPlaceholder("alpha beta", 6);
    const secondInsertion = insertInlineTerminalContextPlaceholder(firstInsertion.prompt, 0);

    expect(
      useComposerDraftStore
        .getState()
        .insertTerminalContext(
          threadRef,
          firstInsertion.prompt,
          makeTerminalContext({ id: "ctx-1" }),
          firstInsertion.contextIndex,
        ),
    ).toBe(true);
    expect(
      useComposerDraftStore.getState().insertTerminalContext(
        threadRef,
        secondInsertion.prompt,
        makeTerminalContext({
          id: "ctx-2",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
        }),
        secondInsertion.contextIndex,
      ),
    ).toBe(true);

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.prompt).toBe(
      `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} alpha ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} beta`,
    );
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-2", "ctx-1"]);
  });

  it("omits terminal context text from persisted drafts", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadRef, makeTerminalContext({ id: "ctx-persist" }));

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
      };
    };
    const persistedState = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey?: Record<string, { terminalContexts?: Array<Record<string, unknown>> }>;
    };

    expect(
      persistedState.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.terminalContexts?.[0],
      "Expected terminal context metadata to be persisted.",
    ).toMatchObject({
      id: "ctx-persist",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 4,
      lineEnd: 5,
    });
    expect(
      persistedState.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.terminalContexts?.[0]?.text,
    ).toBeUndefined();
  });

  it("hydrates persisted terminal contexts without in-memory snapshot text", () => {
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
            prompt: INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
            attachments: [],
            terminalContexts: [
              {
                id: "ctx-rehydrated",
                threadId,
                createdAt: "2026-03-13T12:00:00.000Z",
                terminalId: "default",
                terminalLabel: "Terminal 1",
                lineStart: 4,
                lineEnd: 5,
              },
            ],
          },
        },
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectKey: {},
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadKey[threadKeyFor(threadId)]?.terminalContexts).toMatchObject([
      {
        id: "ctx-rehydrated",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 5,
        text: "",
      },
    ]);
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

describe("composerDraftStore element contexts", () => {
  const threadId = ThreadId.make("thread-element");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
  const baseSelection = {
    pageUrl: "https://example.com/dashboard",
    pageTitle: "Dashboard",
    tagName: "button",
    selector: "button.submit",
    htmlPreview: "<button>Save</button>",
    componentName: "SubmitButton",
    source: {
      functionName: "SubmitButton",
      fileName: "/repo/Button.tsx",
      lineNumber: 12,
      columnNumber: 5,
    },
    styles: ".submit { color: white; }",
  } as const;

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("adds an element context and stamps id + threadId + pickedAt", () => {
    const accepted = useComposerDraftStore.getState().addElementContext(threadRef, baseSelection);
    expect(accepted).toBe(true);
    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.elementContexts).toHaveLength(1);
    const entry = draft?.elementContexts[0]!;
    expect(entry.id.startsWith("el_")).toBe(true);
    expect(entry.threadId).toBe(threadId);
    expect(entry.pickedAt.length).toBeGreaterThan(0);
    expect(entry.componentName).toBe("SubmitButton");
  });

  it("dedupes by selector + tag + componentName + pageUrl signature", () => {
    const store = useComposerDraftStore.getState();
    expect(store.addElementContext(threadRef, baseSelection)).toBe(true);
    const second = store.addElementContext(threadRef, {
      ...baseSelection,
      htmlPreview: "<button>Save 2</button>",
    });
    expect(second).toBe(false);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.elementContexts).toHaveLength(1);
  });

  it("removeElementContext drops by id + leaves siblings intact", () => {
    const store = useComposerDraftStore.getState();
    store.addElementContext(threadRef, baseSelection);
    store.addElementContext(threadRef, { ...baseSelection, selector: "button.cancel" });
    const ids = draftFor(threadId, TEST_ENVIRONMENT_ID)!.elementContexts.map((c) => c.id);
    store.removeElementContext(threadRef, ids[0]!);
    const remaining = draftFor(threadId, TEST_ENVIRONMENT_ID)?.elementContexts;
    expect(remaining?.map((c) => c.id)).toEqual([ids[1]]);
  });

  it("setElementContexts replaces the slice and clearComposerContent wipes it", () => {
    const store = useComposerDraftStore.getState();
    store.addElementContext(threadRef, baseSelection);
    store.setElementContexts(threadRef, []);
    // Fully empty draft should be removed via shouldRemoveDraft.
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();

    store.addElementContext(threadRef, baseSelection);
    store.clearComposerContent(threadRef);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("persists element contexts via the partializer (round-trippable)", () => {
    useComposerDraftStore.getState().addElementContext(threadRef, baseSelection);
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
      };
    };
    const persisted = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey?: Record<string, { elementContexts?: Array<Record<string, unknown>> }>;
    };
    const entry =
      persisted.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.elementContexts?.[0];
    expect(entry).toMatchObject({
      pageUrl: baseSelection.pageUrl,
      tagName: baseSelection.tagName,
      selector: baseSelection.selector,
      componentName: baseSelection.componentName,
    });
    // Persistence does NOT include htmlPreview / styles oversize-clamping —
    // that happens at normalization time, before the value reaches the store.
    expect(typeof entry?.htmlPreview).toBe("string");
  });
});

describe("composerDraftStore review comments", () => {
  const threadId = ThreadId.make("thread-review-comment");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
  const comment = {
    id: "comment-1",
    sectionId: "file:src/app.ts",
    sectionTitle: "File comment",
    filePath: "src/app.ts",
    startIndex: 1,
    endIndex: 2,
    rangeLabel: "L2 to L3",
    text: "Keep this configurable.",
    diff: "@@ -2,2 +2,2 @@\n two\n three",
  } as const;

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("upserts and removes review comments by id", () => {
    const store = useComposerDraftStore.getState();
    store.addReviewComment(threadRef, comment);
    store.addReviewComment(threadRef, { ...comment, text: "Updated comment." });

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.reviewComments).toEqual([
      { ...comment, text: "Updated comment." },
    ]);

    store.removeReviewComment(threadRef, comment.id);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("persists review comments and clears them with composer content", () => {
    const store = useComposerDraftStore.getState();
    store.addReviewComment(threadRef, comment);
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        partialize: (state: ReturnType<typeof useComposerDraftStore.getState>) => unknown;
      };
    };
    const persisted = persistApi.getOptions().partialize(useComposerDraftStore.getState()) as {
      draftsByThreadKey?: Record<string, { reviewComments?: Array<Record<string, unknown>> }>;
    };

    expect(
      persisted.draftsByThreadKey?.[threadKeyFor(threadId, TEST_ENVIRONMENT_ID)]
        ?.reviewComments?.[0],
    ).toMatchObject(comment);

    store.clearComposerContent(threadRef);
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });

  it("stores review comments against a new-thread draft id", () => {
    const draftId = DraftId.make("draft-review-comment");
    useComposerDraftStore.getState().addReviewComment(draftId, comment);

    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.reviewComments).toEqual([
      comment,
    ]);
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

      clearComposerDraftsEnvironment(TEST_ENVIRONMENT_ID);

      const next = useComposerDraftStore.getState();
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

  it("stores and reads project draft thread ids via actions", () => {
    const store = useComposerDraftStore.getState();
    expect(store.getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(store.getDraftThread(draftId)).toBeNull();

    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toMatchObject({
      threadId,
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      logicalProjectKey: scopedProjectKey(projectRef),
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      logicalProjectKey: scopedProjectKey(projectRef),
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
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
    markPromotedDraftThread(threadId);

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

  it("clears project draft mapping by project id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "hello");
    store.clearProjectDraftThreadId(projectRef);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

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

  it("revokes draft image blob URLs when clearing a matching project draft thread by id", () => {
    const store = useComposerDraftStore.getState();
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    const revokeSpy = vi.fn<(url: string) => void>();
    URL.revokeObjectURL = revokeSpy;

    try {
      store.setProjectDraftThreadId(projectRef, draftId, { threadId });
      store.addImage(
        draftId,
        makeImage({ id: "img-project-clear-by-id", previewUrl: "blob:clear-by-id" }),
      );

      store.clearProjectDraftThreadById(projectRef, draftId);

      expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
      expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
      expect(revokeSpy).toHaveBeenCalledWith("blob:clear-by-id");
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

  it("keeps invested composer drafts alive unmapped when remapping a project to a new draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "keep me around");

    store.setProjectDraftThreadId(projectRef, otherDraftId, { threadId: otherThreadId });

    // The mapping moved to the fresh draft...
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      otherThreadId,
    );
    // ...but the invested draft survives with its content for the sidebar
    // draft rows to surface.
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.threadId).toBe(threadId);
    expect(draftByKey(draftId)?.prompt).toBe("keep me around");
  });

  it("clears every session for a project, including unmapped invested drafts", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "invested");
    // The remap leaves the invested draft alive unmapped; project removal
    // must still sweep it, or its sidebar row outlives the project.
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

  it("clears draft registration independently", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "remove me");
    store.clearDraftThread(draftId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("marks a promoted draft by thread id without deleting composer state", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "promote me");

    markPromotedDraftThread(threadId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.promotedTo).toEqual(
      scopeThreadRef(TEST_ENVIRONMENT_ID, threadId),
    );
    expect(draftByKey(draftId)?.prompt).toBe("promote me");
  });

  it("reads local draft composer state through a scoped thread ref", () => {
    const store = useComposerDraftStore.getState();
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "scoped access");

    expect(store.getComposerDraft(draftId)?.prompt).toBe("scoped access");
    expect(store.getComposerDraft(threadRef)?.prompt).toBe("scoped access");
  });

  it("does not clear composer drafts for existing server threads during promotion cleanup", () => {
    const store = useComposerDraftStore.getState();
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
    store.setPrompt(threadRef, "keep me");

    markPromotedDraftThread(threadId);

    expect(useComposerDraftStore.getState().getDraftThread(threadRef)).toBeNull();
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe("keep me");
  });

  it("marks promoted drafts from an iterable of server thread ids", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "promote me");
    store.setProjectDraftThreadId(otherProjectRef, otherDraftId, { threadId: otherThreadId });
    store.setPrompt(otherDraftId, "keep me");

    markPromotedDraftThreads([threadId]);

    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.promotedTo).toEqual(
      scopeThreadRef(TEST_ENVIRONMENT_ID, threadId),
    );
    expect(draftByKey(draftId)?.prompt).toBe("promote me");
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectRef(otherProjectRef)?.threadId,
    ).toBe(otherThreadId);
    expect(draftByKey(otherDraftId)?.prompt).toBe("keep me");
  });

  it("marks every matching scoped draft when multiple environments share a thread id", () => {
    const store = useComposerDraftStore.getState();
    const localThreadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
    const remoteThreadRef = scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, threadId);

    store.setProjectDraftThreadId(projectRef, localDraftId, { threadId });
    store.setPrompt(localDraftId, "local draft");
    store.setProjectDraftThreadId(remoteProjectRef, remoteDraftId, { threadId });
    store.setPrompt(remoteDraftId, "remote draft");

    markPromotedDraftThread(threadId);

    expect(store.getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(store.getDraftThreadByProjectRef(remoteProjectRef)).toBeNull();
    expect(store.getDraftThreadByRef(localThreadRef)?.promotedTo).toEqual(localThreadRef);
    expect(store.getDraftThreadByRef(remoteThreadRef)?.promotedTo).toEqual(remoteThreadRef);
    expect(draftByKey(localDraftId)?.prompt).toBe("local draft");
    expect(draftByKey(remoteDraftId)?.prompt).toBe("remote draft");
  });

  it("only marks promoted drafts for the matching environment ref", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "promote me");

    markPromotedDraftThreadByRef(scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, threadId));

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      threadId,
    );
    expect(draftByKey(draftId)?.prompt).toBe("promote me");
  });

  it("only marks iterable promotion cleanup entries for the matching environment refs", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "promote me");

    markPromotedDraftThreadsByRef([scopeThreadRef(OTHER_TEST_ENVIRONMENT_ID, threadId)]);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      threadId,
    );
    expect(draftByKey(draftId)?.prompt).toBe("promote me");
  });

  it("keeps existing server-thread composer drafts during iterable promotion cleanup", () => {
    const store = useComposerDraftStore.getState();
    const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);
    store.setPrompt(threadRef, "keep me");

    markPromotedDraftThreads([threadId]);

    expect(useComposerDraftStore.getState().getDraftThread(threadRef)).toBeNull();
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.prompt).toBe("keep me");
  });

  it("finalizes a promoted draft after the canonical thread route is active", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "promote me");
    markPromotedDraftThread(threadId);

    finalizePromotedDraftThreadByRef(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId));

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("finalizes a matching materialized draft even when promotion was not pre-marked", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "promote me");

    finalizePromotedDraftThreadByRef(scopeThreadRef(TEST_ENVIRONMENT_ID, threadId));

    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toBeNull();
    expect(draftByKey(draftId)).toBeUndefined();
  });

  it("updates branch context on an existing draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: "main",
      worktreePath: null,
    });
    store.setDraftThreadContext(draftId, {
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectRef(projectRef)?.threadId).toBe(
      threadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
      envMode: "worktree",
    });
  });

  it("stores the start-from-origin choice with the draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      envMode: "worktree",
      startFromOrigin: true,
    });

    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.startFromOrigin).toBe(true);

    store.setDraftThreadContext(draftId, { startFromOrigin: false });

    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.startFromOrigin).toBe(false);
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

  it("preserves worktree env mode without a worktree path", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
      envMode: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: "local" | "worktree";
    };
    store.setProjectDraftThreadId(projectRef, draftId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(draftId)).toMatchObject({
      environmentId: TEST_ENVIRONMENT_ID,
      projectId,
      branch: "feature/base",
      worktreePath: null,
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

  it("clears branch and worktree but keeps env mode when changing a draft thread project ref", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: "feature/local-only",
      worktreePath: "/tmp/local-worktree",
      envMode: "worktree",
      startFromOrigin: true,
    });

    store.setDraftThreadContext(draftId, {
      projectRef: remoteProjectRef,
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
});

describe("composerDraftStore modelSelection", () => {
  const threadId = ThreadId.make("thread-model-options");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a model selection in the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadRef,
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );
  });

  it("keeps default-only model selections on the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(modelSelection(CODEX_DRIVER, "gpt-5.4"));
  });

  it("marks picker writes explicit and seeding writes non-explicit", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionExplicit).toBeUndefined();

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"), {
      explicit: true,
    });
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionExplicit).toBe(true);

    // Last writer defines intent: a later seed clears the marker.
    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"), {
      replaceOptions: true,
    });
    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionExplicit).toBeUndefined();
  });

  it("persists the explicit marker through storage round-trips", async () => {
    vi.useFakeTimers();
    try {
      useComposerDraftStore
        .getState()
        .setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"), {
          explicit: true,
        });
      // Land the debounced persist write.
      await vi.advanceTimersByTimeAsync(300);

      // Hydrate from the same storage the store persists into and verify the
      // marker survives the partialize → decode → merge path.
      resetComposerDraftStore();
      await useComposerDraftStore.persist.rehydrate();
      expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionExplicit).toBe(true);
      expect(
        draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
      ).toEqual(modelSelection(CODEX_DRIVER, "gpt-5.4"));
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps explicit default-state overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        effort: "max",
      }),
    );

    store.setProviderModelOptions(threadRef, CLAUDE_AGENT_DRIVER, toSelections({ thinking: true }));

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE],
    ).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", {
        thinking: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual({});
  });

  it("keeps explicit off/default codex overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4", { fastMode: true }));

    store.setProviderModelOptions(
      threadRef,
      CODEX_DRIVER,
      toSelections({ reasoningEffort: "high", fastMode: false }),
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.4", {
        reasoningEffort: "high",
        fastMode: false,
      }),
    );
  });

  it("keeps explicit Cursor reset overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadRef,
      modelSelection(CURSOR_DRIVER, "claude-opus-4-6", {
        reasoning: "xhigh",
        fastMode: true,
        thinking: false,
      }),
    );

    store.setProviderModelOptions(
      threadRef,
      CURSOR_DRIVER,
      toSelections({ reasoning: "medium", fastMode: false, thinking: true }),
    );

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(
      modelSelection(CURSOR_DRIVER, "claude-opus-4-6", {
        reasoning: "medium",
        fastMode: false,
        thinking: true,
      }),
    );
  });

  it("preserves the selected Cursor model when only traits change", () => {
    const store = useComposerDraftStore.getState();

    store.setProviderModelOptions(threadRef, CURSOR_DRIVER, toSelections({ reasoning: "high" }), {
      model: "gpt-5.4",
      persistSticky: true,
    });

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(
      modelSelection(CURSOR_DRIVER, "gpt-5.4", {
        reasoning: "high",
      }),
    );
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(
      modelSelection(CURSOR_DRIVER, "gpt-5.4", {
        reasoning: "high",
      }),
    );
  });

  it("updates only the draft when sticky persistence is omitted", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );
    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );

    store.setProviderModelOptions(
      threadRef,
      CLAUDE_AGENT_DRIVER,
      toSelections({ thinking: false }),
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
    ).toEqual(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }));
  });

  it("does not clear other provider options when setting options for a single provider", () => {
    const store = useComposerDraftStore.getState();

    // Set options for both providers
    store.setModelOptions(
      threadRef,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    // Now set options for only codex — claudeAgent should be untouched
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

  it("preserves other provider options when switching the active model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelOptions(
      threadRef,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    store.setModelSelection(threadRef, modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6"));

    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE]).toEqual(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );
    expect(draft?.modelSelectionByProvider[CODEX_INSTANCE]?.options).toEqual(
      createModelSelection(CODEX_INSTANCE, "gpt-5.4", toSelections({ fastMode: true })).options,
    );
    expect(draft?.activeProvider).toBe("claudeAgent");
  });

  it("creates the first sticky snapshot from provider option changes", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.4"));

    store.setProviderModelOptions(threadRef, CODEX_DRIVER, toSelections({ fastMode: true }), {
      persistSticky: true,
    });

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.4", {
        fastMode: true,
      }),
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

  it("updates only the draft when sticky persistence is disabled", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );
    store.setModelSelection(
      threadRef,
      modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }),
    );

    store.setProviderModelOptions(
      threadRef,
      CLAUDE_AGENT_DRIVER,
      toSelections({ thinking: false }),
      {
        persistSticky: false,
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
    ).toEqual(modelSelection(CLAUDE_AGENT_DRIVER, "claude-opus-4-6", { effort: "max" }));
  });
});

describe("composerDraftStore setModelSelection", () => {
  const threadId = ThreadId.make("thread-model");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("keeps explicit model overrides instead of coercing to null", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadRef, modelSelection(CODEX_DRIVER, "gpt-5.3-codex"));

    expect(
      draftFor(threadId, TEST_ENVIRONMENT_ID)?.modelSelectionByProvider[CODEX_INSTANCE],
    ).toEqual(modelSelection(CODEX_DRIVER, "gpt-5.3-codex"));
  });
});

describe("composerDraftStore sticky composer settings", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a sticky model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("normalizes empty sticky model options by dropping selection options", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(modelSelection(CODEX_DRIVER, "gpt-5.4"));

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.4"),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("drops empty cursor model options when normalizing sticky state", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection(CURSOR_DRIVER, "gpt-5.4", {
        reasoning: undefined,
        fastMode: undefined,
        thinking: undefined,
        contextWindow: undefined,
      }),
    );

    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[CURSOR_INSTANCE],
    ).toEqual(modelSelection(CURSOR_DRIVER, "gpt-5.4"));
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("cursor");
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

describe("composerDraftStore provider-scoped option updates", () => {
  const threadId = ThreadId.make("thread-provider");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("retains off-provider option memory without changing the active selection", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadRef,
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", {
        reasoningEffort: "medium",
      }),
    );
    store.setProviderModelOptions(threadRef, CLAUDE_AGENT_DRIVER, toSelections({ effort: "max" }));
    const draft = draftFor(threadId, TEST_ENVIRONMENT_ID);
    expect(draft?.modelSelectionByProvider[CODEX_INSTANCE]).toEqual(
      modelSelection(CODEX_DRIVER, "gpt-5.3-codex", { reasoningEffort: "medium" }),
    );
    expect(draft?.modelSelectionByProvider[CLAUDE_AGENT_INSTANCE]?.options).toEqual(
      createModelSelection(
        CLAUDE_AGENT_INSTANCE,
        "claude-opus-4-6",
        toSelections({ effort: "max" }),
      ).options,
    );
    expect(draft?.activeProvider).toBe("codex");
  });
});

describe("composerDraftStore runtime and interaction settings", () => {
  const threadId = ThreadId.make("thread-settings");
  const threadRef = scopeThreadRef(TEST_ENVIRONMENT_ID, threadId);

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores runtime mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadRef, "approval-required");

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.runtimeMode).toBe("approval-required");
  });

  it("stores interaction mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setInteractionMode(threadRef, "plan");

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)?.interactionMode).toBe("plan");
  });

  it("removes empty settings-only drafts when overrides are cleared", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadRef, "approval-required");
    store.setInteractionMode(threadRef, "plan");
    store.setRuntimeMode(threadRef, null);
    store.setInteractionMode(threadRef, null);

    expect(draftFor(threadId, TEST_ENVIRONMENT_ID)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createDebouncedStorage
// ---------------------------------------------------------------------------

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

describe("createDebouncedStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates getItem immediately", () => {
    const base = createMockStorage();
    base.getItem.mockReturnValueOnce("value");
    const storage = createDebouncedStorage(base);

    expect(storage.getItem("key")).toBe("value");
    expect(base.getItem).toHaveBeenCalledWith("key");
  });

  it("does not write to base storage until the debounce fires", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v1");
  });

  it("only writes the last value when setItem is called rapidly", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.setItem("key", "v2");
    storage.setItem("key", "v3");

    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v3");
  });

  it("removeItem cancels a pending setItem write", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");

    vi.advanceTimersByTime(300);
    expect(base.setItem).not.toHaveBeenCalled();
    expect(base.removeItem).toHaveBeenCalledWith("key");
  });

  it("flush writes the pending value immediately", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    storage.flush();
    expect(base.setItem).toHaveBeenCalledWith("key", "v1");

    // Timer should be cancelled; no duplicate write.
    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
  });

  it("flush is a no-op when nothing is pending", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.flush();
    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("flush after removeItem is a no-op", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.flush();

    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("setItem works normally after removeItem cancels a pending write", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.setItem("key", "v2");

    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v2");
  });
});
