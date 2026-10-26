import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  COMPOSER_CONTEXT_MAX_RECORDS,
  ComposerContextId,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "@t3tools/shared/composerContextReferences";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  download: vi.fn(),
  persist: vi.fn(),
  remove: vi.fn(),
  local: vi.fn(),
  preview: vi.fn(),
  dispose: vi.fn(),
  sequence: 0,
}));
vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));
vi.mock("expo-file-system", () => ({
  File: class {
    size = 42;
  },
}));
vi.mock("../state/atom-registry", () => ({
  appAtomRegistry: {
    get: () => ({ _tag: "Some", value: { httpBaseUrl: "https://source.example" } }),
  },
}));
vi.mock("../state/session", () => ({
  environmentSession: { preparedConnectionValueAtom: vi.fn() },
}));
vi.mock("../state/assets", () => ({ assetEnvironment: { createUrl: (value: unknown) => value } }));
vi.mock("../state/use-composer-drafts", () => ({
  waitForComposerDraftsLoaded: async () => {},
  findLocalComposerClipboardAttachment: mocks.local,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.execute,
  squashAtomCommandFailure: () => new Error("offline"),
}));
vi.mock("./attachmentDownload", () => ({ downloadAttachmentForPreview: mocks.download }));
vi.mock("./localAttachmentPreview", () => ({ loadLocalAttachmentPreview: mocks.preview }));
vi.mock("./composerImages", () => ({
  persistComposerAttachmentFile: mocks.persist,
  removePersistedComposerAttachmentFile: mocks.remove,
}));
vi.mock("./uuid", () => ({ uuidv4: () => `import-${++mocks.sequence}` }));

import { importComposerContextClipboard } from "./composerContextClipboard";
import { createComposerContextHistory } from "./composerContext";

const image = {
  version: 1 as const,
  kind: "image" as const,
  contextId: ComposerContextId.make("image-source"),
  label: "Checkout",
  name: "checkout.png",
  mimeType: "image/png",
  sizeBytes: 7,
  attachmentId: "source-file",
};
const terminal = {
  version: 1 as const,
  kind: "terminal" as const,
  contextId: ComposerContextId.make("terminal-source"),
  label: "Build",
  terminalId: "main",
  terminalLabel: "Terminal",
  lineStart: 1,
  lineEnd: 1,
  text: "Build failed",
};
const clipboard = {
  text: "![Checkout](t3-context://v1/image/image-source) [Build](t3-context://v1/terminal/terminal-source)",
  fragment: encodeComposerContextFragment({
    version: 1,
    source: { environmentId: EnvironmentId.make("source") },
    records: [image, terminal],
  })!,
  html: "",
};

const localThread = {
  version: 1 as const,
  kind: "thread" as const,
  contextId: ComposerContextId.make("thread_local-thread"),
  label: "Local discussion",
  environmentId: EnvironmentId.make("destination"),
  threadId: ThreadId.make("local-thread"),
  title: "Local discussion",
};
const foreignThread = {
  ...localThread,
  contextId: ComposerContextId.make("thread_foreign-thread"),
  label: "Remote discussion",
  environmentId: EnvironmentId.make("source"),
  threadId: ThreadId.make("foreign-thread"),
  title: "Remote discussion",
};
const mixedRecords = [foreignThread, localThread, terminal, image];
const mixedClipboard = {
  text: `Compare these findings: ${mixedRecords.map(formatComposerContextReference).join(" ")} before changing anything.`,
  fragment: encodeComposerContextFragment({
    version: 1,
    source: { environmentId: EnvironmentId.make("source") },
    records: [
      ...mixedRecords,
      {
        ...foreignThread,
        contextId: ComposerContextId.make("thread_uncopied-thread"),
        threadId: ThreadId.make("uncopied-thread"),
        title: "Not in the copied selection",
      },
    ],
  })!,
  html: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sequence = 0;
  mocks.local.mockReturnValue(undefined);
  mocks.execute.mockResolvedValue({ _tag: "Success", value: { relativeUrl: "/assets/source" } });
  mocks.download.mockResolvedValue({ uri: "file:///download.png", dispose: mocks.dispose });
  mocks.persist.mockResolvedValue("file:///owned.png");
  mocks.remove.mockResolvedValue(undefined);
});

describe("mobile context clipboard imports", () => {
  it("copies original bytes and rewrites file bindings using a signal without throwIfAborted", async () => {
    const signal = { aborted: false } as AbortSignal;
    const result = await importComposerContextClipboard(clipboard, 0, signal);
    expect(result?.failures).toEqual([]);
    expect(result?.attachments[0]).toMatchObject({ fileUri: "file:///owned.png", sizeBytes: 42 });
    expect(result?.context.records[0]).toMatchObject({
      contextId: "import-1",
      attachmentId: result?.attachments[0]?.id,
    });
    expect(result?.context.records[1]).toMatchObject({ text: "Build failed" });
    expect(result?.text).toContain("/image/import-1)");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("keeps failed attachment references visibly unavailable without dropping text context", async () => {
    mocks.download.mockRejectedValue(new Error("source disconnected"));
    const result = await importComposerContextClipboard(clipboard, 0, new AbortController().signal);
    expect(result?.attachments).toEqual([]);
    expect(result?.failures).toEqual(["checkout.png"]);
    expect(result?.text).toContain("/image/import-1)");
    expect(result?.context.records).toEqual([{ ...terminal, contextId: "import-2" }]);
  });

  it("releases a newly owned file if the destination closes during its copy", async () => {
    const controller = new AbortController();
    mocks.persist.mockImplementationOnce(async () => {
      controller.abort();
      return "file:///owned.png";
    });
    await expect(importComposerContextClipboard(clipboard, 0, controller.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(mocks.remove).toHaveBeenCalledWith("file:///owned.png");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("releases its files if cancelled after the last copy finishes", async () => {
    const controller = new AbortController();
    mocks.dispose.mockImplementationOnce(() => controller.abort());
    const imageOnly = {
      text: "![Checkout](t3-context://v1/image/image-source)",
      fragment: encodeComposerContextFragment({
        version: 1,
        source: { environmentId: EnvironmentId.make("source") },
        records: [image],
      })!,
      html: "",
    };
    await expect(importComposerContextClipboard(imageOnly, 0, controller.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(mocks.remove).toHaveBeenCalledWith("file:///owned.png");
  });

  it("can copy an image before its source upload completes", async () => {
    mocks.local.mockReturnValue({
      id: "source-file",
      type: "image",
      dataUrl: "data:image/png;base64,YWJj",
      previewUri: "data:image/png;base64,YWJj",
      name: "checkout.png",
      mimeType: "image/png",
      sizeBytes: 3,
    });
    const result = await importComposerContextClipboard(clipboard, 0, new AbortController().signal);
    expect(result?.attachments[0]).toMatchObject({
      dataUrl: "data:image/png;base64,YWJj",
      uploadedAttachmentId: undefined,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("pastes local threads, text context and files at the cap after excluding foreign threads", async () => {
    const result = await importComposerContextClipboard(
      mixedClipboard,
      0,
      new AbortController().signal,
      COMPOSER_CONTEXT_MAX_RECORDS - 3,
      EnvironmentId.make("destination"),
    );
    expect(result).not.toBeNull();
    expect(result!.context.records).toEqual([
      { ...localThread, contextId: expect.any(String) },
      { ...terminal, contextId: expect.any(String) },
      { ...image, contextId: expect.any(String), attachmentId: result!.attachments[0]!.id },
    ]);
    expect(result!.attachments).toEqual([
      expect.objectContaining({ name: image.name, fileUri: "file:///owned.png" }),
    ]);
    expect(result!.failures).toEqual([]);
    expect(result!.skippedThreads).toEqual([foreignThread.title]);
    const references = collectComposerContextReferences(result!.text);
    expect(references.map((reference) => reference.label)).toEqual(
      mixedRecords.map((record) => record.label),
    );
    expect(result!.context.records.map((record) => record.contextId)).toEqual(
      references.slice(1).map((reference) => reference.contextId),
    );
    expect(
      references.every(
        (reference) => !mixedRecords.some((record) => record.contextId === reference.contextId),
      ),
    ).toBe(true);
    expect(
      result!.context.records.some((record) => record.contextId === references[0]!.contextId),
    ).toBe(false);
    expect(result!.text).toMatch(/^Compare these findings: .* before changing anything\.$/);

    const restoreHistory = createComposerContextHistory();
    restoreHistory(formatComposerContextReference(foreignThread), {
      version: 1,
      records: [foreignThread],
    });
    expect(restoreHistory(`${result!.text} Next step`, result!.context)).toEqual(result!.context);

    mocks.download.mockClear();
    await expect(
      importComposerContextClipboard(
        mixedClipboard,
        0,
        new AbortController().signal,
        COMPOSER_CONTEXT_MAX_RECORDS - 2,
        EnvironmentId.make("destination"),
      ),
    ).rejects.toThrow("Remove some context");
    expect(mocks.download).not.toHaveBeenCalled();
  });

  // regression: #18322 don't send or paste attached threads a machine can't read
  it("reports foreign threads and failed files together while keeping the rest of a paste", async () => {
    mocks.download.mockRejectedValueOnce(new Error("source disconnected"));
    const result = await importComposerContextClipboard(
      mixedClipboard,
      0,
      new AbortController().signal,
      0,
      EnvironmentId.make("destination"),
    );
    expect(result).not.toBeNull();
    expect(result!.context.records).toEqual([
      { ...localThread, contextId: expect.any(String) },
      { ...terminal, contextId: expect.any(String) },
    ]);
    expect(result!.attachments).toEqual([]);
    expect(result!.failures).toEqual([image.name]);
    expect(result!.skippedThreads).toEqual([foreignThread.title]);
    const references = collectComposerContextReferences(result!.text);
    expect(references.map((reference) => reference.label)).toEqual(
      mixedRecords.map((record) => record.label),
    );
    expect(
      references
        .filter(
          (reference) =>
            !result!.context.records.some((record) => record.contextId === reference.contextId),
        )
        .map((reference) => reference.label),
    ).toEqual([foreignThread.label, image.label]);
    expect(result!.text).toMatch(/^Compare these findings: .* before changing anything\.$/);
  });

  it("preserves both machines' thread references when pasting without a destination", async () => {
    const result = await importComposerContextClipboard(
      mixedClipboard,
      0,
      new AbortController().signal,
    );
    expect(result).not.toBeNull();
    expect(result!.context.records).toEqual([
      { ...foreignThread, contextId: expect.any(String) },
      { ...localThread, contextId: expect.any(String) },
      { ...terminal, contextId: expect.any(String) },
      { ...image, contextId: expect.any(String), attachmentId: result!.attachments[0]!.id },
    ]);
    expect(result!.attachments).toHaveLength(1);
    expect(result!.failures).toEqual([]);
    expect(
      collectComposerContextReferences(result!.text).map((reference) => reference.contextId),
    ).toEqual(result!.context.records.map((record) => record.contextId));
  });
});
