import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ComposerContextId, EnvironmentId } from "@t3tools/contracts";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";

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

  it("refuses an overflowing context paste before copying files", async () => {
    await expect(
      importComposerContextClipboard(clipboard, 0, new AbortController().signal, 200),
    ).rejects.toThrow("Remove some context");
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
