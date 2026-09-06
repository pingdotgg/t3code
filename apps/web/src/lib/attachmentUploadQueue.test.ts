import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  composerFileNeedsReattach,
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../composerDraftStore";

const mocks = vi.hoisted(() => ({
  createAssetUrl: vi.fn(),
  createUploadUrl: Symbol("create-upload-url"),
  executeAtomQuery: vi.fn(),
  removeUpload: Symbol("remove-upload"),
  runAtomCommand: vi.fn(),
  readPreparedConnection: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.executeAtomQuery,
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));

vi.mock("../state/assets", () => ({
  assetEnvironment: { createUrl: mocks.createAssetUrl },
}));

vi.mock("../state/attachments", () => ({
  attachmentEnvironment: {
    createUploadUrl: mocks.createUploadUrl,
    remove: mocks.removeUpload,
  },
}));

vi.mock("../state/session", () => ({
  readPreparedConnection: mocks.readPreparedConnection,
}));

import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  releaseDraftAttachment,
  releaseDraftAttachments,
  releasePersistedAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "./attachmentUploadQueue";

type ProgressListener = (event: {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
}) => void;

class TestXmlHttpRequest {
  static requests: TestXmlHttpRequest[] = [];

  status = 0;
  timeout = 0;
  method: string | null = null;
  url: string | null = null;
  readonly headers = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  progressListener: ProgressListener | null = null;

  readonly upload = {
    addEventListener: (_event: string, listener: ProgressListener) => {
      this.progressListener = listener;
    },
  };

  constructor() {
    TestXmlHttpRequest.requests.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, listener);
  }

  send(): void {}

  abort(): void {
    this.listeners.get("abort")?.();
  }

  progress(loaded: number, total: number): void {
    this.progressListener?.({ lengthComputable: true, loaded, total });
  }

  complete(status = 204): void {
    this.status = status;
    this.listeners.get("load")?.();
  }
}

const firstEnvironment = EnvironmentId.make("environment-1");
const secondEnvironment = EnvironmentId.make("environment-2");

function makeImage(id: string): ComposerImageAttachment {
  const file = new File([new Uint8Array([1, 2, 3])], `${id}.png`, { type: "image/png" });
  return {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

function makeFile(id: string): ComposerFileAttachment {
  const file = new File([new Uint8Array([1, 2, 3])], `${id}.pdf`, {
    type: "application/pdf",
  });
  return {
    type: "file",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
}

describe("attachmentUploadQueue", () => {
  beforeEach(() => {
    TestXmlHttpRequest.requests = [];
    mocks.createAssetUrl.mockReset();
    mocks.createAssetUrl.mockImplementation((target: unknown) => target);
    mocks.executeAtomQuery.mockReset();
    mocks.executeAtomQuery.mockResolvedValue({ _tag: "Success", value: {} });
    mocks.runAtomCommand.mockReset();
    mocks.readPreparedConnection.mockReset();
    mocks.readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://environment.test/" });
    mocks.runAtomCommand.mockImplementation(
      async (
        _registry: unknown,
        command: unknown,
        target: {
          readonly environmentId: EnvironmentId;
          readonly input: { readonly name?: string };
        },
      ) => {
        if (command === mocks.createUploadUrl) {
          const attachmentId = `pending-${target.environmentId}-${target.input.name}`;
          return {
            _tag: "Success",
            value: {
              attachmentId,
              relativeUrl: `/api/attachments/upload/${attachmentId}`,
              expiresAt: 1,
            },
          };
        }
        return { _tag: "Success", value: undefined };
      },
    );
    vi.stubGlobal("XMLHttpRequest", TestXmlHttpRequest);
  });

  afterEach(() => {
    for (const imageId of Object.keys(useAttachmentUploadStore.getState().uploadsByImageId)) {
      releaseAttachmentUpload(imageId);
    }
    vi.unstubAllGlobals();
  });

  it("uploads images immediately and sends attachment references", async () => {
    const image = makeImage("image-1");
    startAttachmentUpload({ environmentId: firstEnvironment, image });
    await Promise.resolve();

    const request = TestXmlHttpRequest.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://environment.test/api/attachments/upload/pending-environment-1-image-1.png",
    );
    request.progress(1, 3);
    expect(readAttachmentUpload(image.id)).toMatchObject({ status: "uploading", progress: 1 / 3 });

    const settled = awaitAttachmentUploads([image.id]);
    request.complete();
    await settled;

    expect(getUploadedAttachments({ environmentId: firstEnvironment, images: [image] })).toEqual([
      {
        type: "image",
        id: "pending-environment-1-image-1.png",
        name: "image-1.png",
        mimeType: "image/png",
        sizeBytes: 3,
      },
    ]);

    releaseDraftAttachments([image]);
    expect(readAttachmentUpload(image.id)).toBeUndefined();
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      {
        environmentId: firstEnvironment,
        input: { attachmentId: "pending-environment-1-image-1.png" },
      },
      expect.anything(),
    );
  });

  it("uploads generic files and sends file attachment references", async () => {
    const file = makeFile("report");
    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    await Promise.resolve();

    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.createUploadUrl,
      {
        environmentId: firstEnvironment,
        input: {
          type: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 3,
        },
      },
      expect.anything(),
    );

    const settled = awaitAttachmentUploads([file.id]);
    TestXmlHttpRequest.requests[0]!.complete();
    await settled;

    expect(getUploadedAttachments({ environmentId: firstEnvironment, images: [file] })).toEqual([
      {
        type: "file",
        id: "pending-environment-1-report.pdf",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 3,
      },
    ]);
  });

  it("uses the fallback MIME type for both the upload claim and request header", async () => {
    const bytes = new File([new Uint8Array([1, 2, 3])], "unknown.bin");
    const file: ComposerFileAttachment = {
      type: "file",
      id: "file-without-browser-mime",
      name: bytes.name,
      mimeType: "application/octet-stream",
      sizeBytes: bytes.size,
      file: bytes,
    };

    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    await Promise.resolve();

    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.createUploadUrl,
      {
        environmentId: firstEnvironment,
        input: {
          type: "file",
          name: "unknown.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 3,
        },
      },
      expect.anything(),
    );
    expect(TestXmlHttpRequest.requests[0]?.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );

    const settled = awaitAttachmentUploads([file.id]);
    TestXmlHttpRequest.requests[0]!.complete();
    await settled;
  });

  it("persists a background completion's ids to the draft with no composer mounted", async () => {
    const draftId = DraftId.make("draft-background-upload");
    const file = makeFile("background");
    const draftStore = useComposerDraftStore.getState();
    draftStore.addFiles(draftId, [file]);
    try {
      startAttachmentUpload({
        environmentId: firstEnvironment,
        image: file,
        draftTarget: draftId,
      });
      await Promise.resolve();

      // No composer effect is subscribed; only the queue can stamp the draft.
      const settled = awaitAttachmentUploads([file.id]);
      TestXmlHttpRequest.requests[0]!.complete();
      await settled;

      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files).toMatchObject([
        {
          id: file.id,
          uploadedAttachmentId: "pending-environment-1-background.pdf",
          uploadEnvironmentId: firstEnvironment,
        },
      ]);
    } finally {
      useComposerDraftStore.getState().clearComposerContent(draftId);
    }
  });

  it("verifies an uploaded file reference before restoring it", async () => {
    const file: ComposerFileAttachment = {
      ...makeFile("restored"),
      file: null,
      uploadedAttachmentId: "pending-restored-pdf",
      uploadEnvironmentId: firstEnvironment,
    };

    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    await awaitAttachmentUploads([file.id]);

    expect(readAttachmentUpload(file.id)).toEqual({
      status: "ready",
      environmentId: firstEnvironment,
      attachmentId: "pending-restored-pdf",
    });
    expect(mocks.createAssetUrl).toHaveBeenCalledWith({
      environmentId: firstEnvironment,
      input: { resource: { _tag: "attachment", attachmentId: "pending-restored-pdf" } },
    });
    expect(TestXmlHttpRequest.requests).toHaveLength(0);
  });

  it("turns an expired persisted file into a marker that a re-pick can replace", async () => {
    const draftId = DraftId.make("draft-expired-upload");
    const file: ComposerFileAttachment = {
      ...makeFile("expired"),
      file: null,
      uploadedAttachmentId: "pending-expired-pdf",
      uploadEnvironmentId: firstEnvironment,
    };
    mocks.executeAtomQuery.mockResolvedValueOnce({
      _tag: "Failure",
      error: { _tag: "AssetAttachmentNotFoundError" },
    });
    useComposerDraftStore.getState().addFiles(draftId, [file]);

    try {
      startAttachmentUpload({
        environmentId: firstEnvironment,
        image: file,
        draftTarget: draftId,
      });
      await awaitAttachmentUploads([file.id]);

      const marker = useComposerDraftStore.getState().getComposerDraft(draftId)?.files[0];
      expect(readAttachmentUpload(file.id)).toBeUndefined();
      expect(marker?.uploadedAttachmentId).toBeUndefined();
      expect(marker?.uploadEnvironmentId).toBeUndefined();
      expect(marker && composerFileNeedsReattach(marker)).toBe(true);

      const replacementBytes = new File([new Uint8Array([1, 2, 3])], file.name, {
        type: file.mimeType,
      });
      const replacement: ComposerFileAttachment = {
        type: "file",
        id: "expired-repicked",
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        file: replacementBytes,
      };
      useComposerDraftStore.getState().addFiles(draftId, [replacement]);
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files).toMatchObject([
        { id: replacement.id, file: replacementBytes },
      ]);

      startAttachmentUpload({
        environmentId: firstEnvironment,
        image: replacement,
        draftTarget: draftId,
      });
      await Promise.resolve();
      const settled = awaitAttachmentUploads([replacement.id]);
      TestXmlHttpRequest.requests[0]!.complete();
      await settled;

      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files).toMatchObject([
        {
          id: replacement.id,
          uploadedAttachmentId: "pending-environment-1-expired.pdf",
          uploadEnvironmentId: firstEnvironment,
        },
      ]);
      const removeCalls = mocks.runAtomCommand.mock.calls.filter(
        ([, command]) => command === mocks.removeUpload,
      );
      expect(removeCalls).toEqual([]);
    } finally {
      useComposerDraftStore.getState().clearComposerContent(draftId);
    }
  });

  it("uploads the original file again when its persisted server upload expired", async () => {
    const file: ComposerFileAttachment = {
      ...makeFile("recoverable"),
      uploadedAttachmentId: "pending-expired-pdf",
      uploadEnvironmentId: firstEnvironment,
    };
    mocks.executeAtomQuery.mockResolvedValueOnce({
      _tag: "Failure",
      error: { _tag: "AssetAttachmentNotFoundError" },
    });

    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    // The verify-then-reupload path crosses several awaits before the
    // transfer starts; drain microtasks until the XHR exists.
    for (let hop = 0; hop < 20 && TestXmlHttpRequest.requests.length === 0; hop += 1) {
      await Promise.resolve();
    }

    const settled = awaitAttachmentUploads([file.id]);
    TestXmlHttpRequest.requests[0]!.complete();
    await settled;

    expect(readAttachmentUpload(file.id)).toMatchObject({
      status: "ready",
      attachmentId: "pending-environment-1-recoverable.pdf",
    });
  });

  it("removes a persisted upload when its draft is discarded during verification", async () => {
    const file: ComposerFileAttachment = {
      ...makeFile("checking"),
      file: null,
      uploadedAttachmentId: "pending-checking-pdf",
      uploadEnvironmentId: firstEnvironment,
    };
    let resolveVerification: (result: {
      readonly _tag: "Success";
      readonly value: object;
    }) => void = () => {};
    mocks.executeAtomQuery.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveVerification = resolve;
      }),
    );

    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    releaseDraftAttachment(file);
    resolveVerification({ _tag: "Success", value: {} });

    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      {
        environmentId: firstEnvironment,
        input: { attachmentId: "pending-checking-pdf" },
      },
      expect.anything(),
    );
  });

  it("keeps the persisted upload when retrying after a transient verification failure", async () => {
    const draftId = DraftId.make("draft-transient-verification");
    const file: ComposerFileAttachment = {
      ...makeFile("flaky"),
      file: null,
      uploadedAttachmentId: "pending-flaky-pdf",
      uploadEnvironmentId: firstEnvironment,
    };
    mocks.executeAtomQuery.mockResolvedValueOnce({
      _tag: "Failure",
      error: new Error("socket closed"),
    });
    useComposerDraftStore.getState().addFiles(draftId, [file]);

    try {
      startAttachmentUpload({
        environmentId: firstEnvironment,
        image: file,
        draftTarget: draftId,
      });
      await awaitAttachmentUploads([file.id]);
      expect(readAttachmentUpload(file.id)).toMatchObject({
        status: "failed",
        reason: "Uploaded file could not be verified. Retry when the server reconnects.",
      });
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files).toMatchObject([
        {
          uploadedAttachmentId: "pending-flaky-pdf",
          uploadEnvironmentId: firstEnvironment,
        },
      ]);

      // The persisted id is the only server copy of the bytes (`file` is null
      // after a reload), so the retry must verify it again, not delete it.
      retryAttachmentUpload({
        environmentId: firstEnvironment,
        image: file,
        draftTarget: draftId,
      });
      await awaitAttachmentUploads([file.id]);

      expect(readAttachmentUpload(file.id)).toEqual({
        status: "ready",
        environmentId: firstEnvironment,
        attachmentId: "pending-flaky-pdf",
      });
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files).toMatchObject([
        {
          uploadedAttachmentId: "pending-flaky-pdf",
          uploadEnvironmentId: firstEnvironment,
        },
      ]);
      const removeCalls = mocks.runAtomCommand.mock.calls.filter(
        ([, command]) => command === mocks.removeUpload,
      );
      expect(removeCalls).toEqual([]);
    } finally {
      useComposerDraftStore.getState().clearComposerContent(draftId);
    }
  });

  it("keeps the persisted upload when an environment switch cancels its verification", async () => {
    const file: ComposerFileAttachment = {
      ...makeFile("moving"),
      file: null,
      uploadedAttachmentId: "pending-moving-pdf",
      uploadEnvironmentId: firstEnvironment,
    };
    let resolveVerification: (result: {
      readonly _tag: "Success";
      readonly value: object;
    }) => void = () => {};
    mocks.executeAtomQuery.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveVerification = resolve;
      }),
    );

    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    // Switching environments cancels the in-flight verification. The draft
    // still references the upload in the first environment, so the cancel
    // must not delete it.
    startAttachmentUpload({ environmentId: secondEnvironment, image: file });
    resolveVerification({ _tag: "Success", value: {} });
    await awaitAttachmentUploads([file.id]);

    const persistedRemoveCalls = mocks.runAtomCommand.mock.calls.filter(
      ([, command, target]) =>
        command === mocks.removeUpload &&
        (target as { readonly input: { readonly attachmentId: string } }).input.attachmentId ===
          "pending-moving-pdf",
    );
    expect(persistedRemoveCalls).toEqual([]);
  });

  it("cancels persisted-upload verification when a stash discards its file", async () => {
    const file: ComposerFileAttachment = {
      ...makeFile("stashed-checking"),
      file: null,
      uploadedAttachmentId: "pending-stashed-checking-pdf",
      uploadEnvironmentId: firstEnvironment,
    };
    let resolveVerification: (result: {
      readonly _tag: "Success";
      readonly value: object;
    }) => void = () => {};
    mocks.executeAtomQuery.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveVerification = resolve;
      }),
    );

    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    releasePersistedAttachmentUpload({
      id: file.id,
      environmentId: firstEnvironment,
      attachmentId: "pending-stashed-checking-pdf",
    });
    resolveVerification({ _tag: "Success", value: {} });
    await Promise.resolve();

    expect(readAttachmentUpload(file.id)).toBeUndefined();
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      {
        environmentId: firstEnvironment,
        input: { attachmentId: "pending-stashed-checking-pdf" },
      },
      expect.anything(),
    );
  });

  it("releases the persisted server upload when a hydrated draft is discarded after a reload", () => {
    // After a reload the in-memory queue is empty; the draft file only carries
    // its persisted attachment id. Discarding it must still delete the
    // server-side pending upload.
    const file: ComposerFileAttachment = {
      ...makeFile("hydrated"),
      file: null,
      uploadedAttachmentId: "pending-hydrated-pdf",
      uploadEnvironmentId: firstEnvironment,
    };

    releaseDraftAttachment(file);

    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      {
        environmentId: firstEnvironment,
        input: { attachmentId: "pending-hydrated-pdf" },
      },
      expect.anything(),
    );
  });

  it("routes a live persisted upload through the queue release exactly once", async () => {
    const file: ComposerFileAttachment = {
      ...makeFile("live"),
      file: null,
      uploadedAttachmentId: "pending-live-pdf",
      uploadEnvironmentId: firstEnvironment,
    };
    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    await awaitAttachmentUploads([file.id]);
    expect(readAttachmentUpload(file.id)).toMatchObject({ status: "ready" });

    releaseDraftAttachment(file);

    expect(readAttachmentUpload(file.id)).toBeUndefined();
    const removeCalls = mocks.runAtomCommand.mock.calls.filter(
      ([, command]) => command === mocks.removeUpload,
    );
    expect(removeCalls).toEqual([
      [
        expect.anything(),
        mocks.removeUpload,
        {
          environmentId: firstEnvironment,
          input: { attachmentId: "pending-live-pdf" },
        },
        expect.anything(),
      ],
    ]);
  });

  it("deletes a persisted server upload even when browser upload state is gone", () => {
    releasePersistedAttachmentUpload({
      id: "stashed-report",
      environmentId: firstEnvironment,
      attachmentId: "pending-00000000-0000-4000-8000-000000000001-pdf",
    });

    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      {
        environmentId: firstEnvironment,
        input: { attachmentId: "pending-00000000-0000-4000-8000-000000000001-pdf" },
      },
      expect.anything(),
    );
  });

  it("retries rejected uploads", async () => {
    const image = makeImage("image-retry");
    startAttachmentUpload({ environmentId: firstEnvironment, image });
    await Promise.resolve();

    let settled = awaitAttachmentUploads([image.id]);
    TestXmlHttpRequest.requests[0]!.complete(500);
    await settled;
    expect(readAttachmentUpload(image.id)).toMatchObject({
      status: "failed",
      reason: "Upload rejected (500)",
    });

    retryAttachmentUpload({ environmentId: firstEnvironment, image });
    await Promise.resolve();
    settled = awaitAttachmentUploads([image.id]);
    TestXmlHttpRequest.requests[1]!.complete();
    await settled;

    expect(readAttachmentUpload(image.id)).toMatchObject({ status: "ready" });
  });

  it("releases an upload URL that resolves after its image was removed", async () => {
    const image = makeImage("image-cancelled");
    const minted = {
      _tag: "Success" as const,
      value: {
        attachmentId: "pending-environment-1-image-cancelled.png",
        relativeUrl: "/api/attachments/upload/cancelled",
        expiresAt: 1,
      },
    };
    let resolveMint: (result: typeof minted) => void = () => {};
    const pendingMint = new Promise<typeof minted>((resolve) => {
      resolveMint = resolve;
    });
    let resolveDelete: () => void = () => {};
    const deleted = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    mocks.runAtomCommand.mockImplementation((_registry: unknown, command: unknown) => {
      if (command === mocks.createUploadUrl) {
        return pendingMint;
      }
      resolveDelete();
      return Promise.resolve({ _tag: "Success", value: undefined });
    });

    startAttachmentUpload({ environmentId: firstEnvironment, image });
    releaseAttachmentUpload(image.id);
    resolveMint(minted);
    await deleted;

    expect(TestXmlHttpRequest.requests).toEqual([]);
    expect(readAttachmentUpload(image.id)).toBeUndefined();
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      {
        environmentId: firstEnvironment,
        input: { attachmentId: minted.value.attachmentId },
      },
      expect.anything(),
    );
  });

  it("restores the previous environment after a replacement upload fails", async () => {
    const image = makeImage("image-move");
    startAttachmentUpload({ environmentId: firstEnvironment, image });
    await Promise.resolve();
    let settled = awaitAttachmentUploads([image.id]);
    TestXmlHttpRequest.requests[0]!.complete();
    await settled;

    startAttachmentUpload({ environmentId: secondEnvironment, image });
    await Promise.resolve();
    settled = awaitAttachmentUploads([image.id]);
    TestXmlHttpRequest.requests[1]!.complete(500);
    await settled;

    startAttachmentUpload({ environmentId: firstEnvironment, image });
    expect(readAttachmentUpload(image.id)).toMatchObject({
      status: "ready",
      environmentId: firstEnvironment,
      attachmentId: "pending-environment-1-image-move.png",
    });
  });

  it("does not let stalled uploads block another environment", async () => {
    const images = ["image-a", "image-b", "image-c", "image-d"].map(makeImage);
    for (const image of images) {
      startAttachmentUpload({ environmentId: firstEnvironment, image });
    }
    const otherEnvironmentImage = makeImage("image-other");
    startAttachmentUpload({ environmentId: secondEnvironment, image: otherEnvironmentImage });
    await Promise.resolve();

    expect(TestXmlHttpRequest.requests).toHaveLength(4);
    const otherRequest = TestXmlHttpRequest.requests.find((request) =>
      request.url?.includes("environment-2"),
    );
    expect(otherRequest).toBeDefined();

    for (const request of TestXmlHttpRequest.requests) {
      request.complete();
    }
    await Promise.all([
      ...images.slice(0, 3).map((image) => awaitAttachmentUploads([image.id])),
      awaitAttachmentUploads([otherEnvironmentImage.id]),
    ]);
    await Promise.resolve();
    TestXmlHttpRequest.requests[4]!.complete();
    await awaitAttachmentUploads([images[3]!.id]);
  });
});
