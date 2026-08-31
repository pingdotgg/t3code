import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  documentUri: "file:///documents",
  createAssetUrl: vi.fn(),
  createUploadUrl: Symbol("create-upload-url"),
  executeAtomQuery: vi.fn(),
  removeUpload: Symbol("remove-upload"),
  preparedConnection: Symbol("prepared-connection"),
  runAtomCommand: vi.fn(),
  readAtom: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  // The client-runtime attachments module resolves the same file through its
  // relative import, so these fakes also feed runAttachmentUploadCycle and
  // verifyPersistedAttachmentUpload.
  createEnvironmentRpcCommand: () => Symbol("rpc-command"),
  executeAtomQuery: mocks.executeAtomQuery,
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

vi.mock("../state/atom-registry", () => ({
  appAtomRegistry: { get: mocks.readAtom },
}));

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
  environmentSession: {
    preparedConnectionValueAtom: () => mocks.preparedConnection,
  },
}));

// Cuts the expo-crypto -> react-native import chain out of the test graph.
vi.mock("./uuid", () => ({
  uuidv4: () => "uuid",
  randomHex: () => "0000",
}));

vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}

    upload(url: string, options: unknown) {
      return mocks.upload(this.uri, url, options);
    }
  },
  Paths: {
    get document() {
      return { uri: mocks.documentUri };
    },
  },
  UploadType: { BINARY_CONTENT: 0 },
}));

import {
  prepareTurnAttachments,
  releasePendingAttachmentUploads,
  withUploadedMobileAttachmentReferences,
  validateDraftFileAttachments,
} from "./attachmentUpload";
import type { DraftComposerAttachment } from "./composerImages";

const environmentId = EnvironmentId.make("environment-1");
const MINTED_ID = "pending-00000000-0000-4000-8000-000000000001-pdf";

const image = {
  id: "image-1",
  type: "image",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 3,
  dataUrl: "data:image/png;base64,YWJj",
  previewUri: "file:///images/screenshot.png",
} as const satisfies DraftComposerAttachment;

const file = {
  id: "file-1",
  type: "file",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 42,
  fileUri: "file:///documents/report.pdf",
} as const satisfies DraftComposerAttachment;

describe("validateDraftFileAttachments", () => {
  it("allows legacy image-only sends without server config", () => {
    expect(validateDraftFileAttachments({ attachments: [image], serverConfig: null })).toBeNull();
  });

  it("blocks files while config is unknown or file uploads are unsupported", () => {
    expect(validateDraftFileAttachments({ attachments: [file], serverConfig: null })).toBe(
      "Server attachment support is still loading.",
    );
    expect(
      validateDraftFileAttachments({
        attachments: [file],
        serverConfig: { environment: { capabilities: { attachmentUploads: true } } },
      }),
    ).toBe("This server does not support file attachments.");
  });

  it("uses the current clamped limit and allows valid mixed attachments", () => {
    const lowerLimit = {
      environment: {
        capabilities: {
          attachmentUploads: true,
          fileAttachments: { maxUploadBytes: 20 },
        },
      },
    };
    expect(validateDraftFileAttachments({ attachments: [file], serverConfig: lowerLimit })).toBe(
      "'report.pdf' exceeds the 20 bytes attachment limit.",
    );
    const allowed = {
      environment: {
        capabilities: {
          attachmentUploads: true,
          fileAttachments: { maxUploadBytes: 100 },
        },
      },
    };
    expect(
      validateDraftFileAttachments({ attachments: [image, file], serverConfig: allowed }),
    ).toBeNull();
  });
});

function removeCallsFor(attachmentId: string): number {
  return mocks.runAtomCommand.mock.calls.filter(
    ([, command, target]) =>
      command === mocks.removeUpload &&
      (target as { input: { attachmentId: string } }).input.attachmentId === attachmentId,
  ).length;
}

describe("prepareTurnAttachments", () => {
  beforeEach(() => {
    mocks.documentUri = "file:///documents";
    mocks.createAssetUrl.mockReset();
    mocks.createAssetUrl.mockImplementation((target: unknown) => target);
    mocks.executeAtomQuery.mockReset();
    mocks.executeAtomQuery.mockResolvedValue({ _tag: "Success", value: {} });
    mocks.runAtomCommand.mockReset();
    mocks.readAtom.mockReset();
    mocks.upload.mockReset();
    mocks.readAtom.mockReturnValue(Option.some({ httpBaseUrl: "https://environment.example/" }));
    mocks.runAtomCommand.mockImplementation(async (_registry: unknown, command: unknown) =>
      command === mocks.createUploadUrl
        ? {
            _tag: "Success",
            value: {
              attachmentId: MINTED_ID,
              relativeUrl: "/api/attachments/upload/signed",
              expiresAt: 1,
            },
          }
        : { _tag: "Success", value: undefined },
    );
    mocks.upload.mockResolvedValue({ status: 204, body: "", headers: {} });
  });

  it("keeps existing image attachments on the legacy wire path", async () => {
    const prepared = await prepareTurnAttachments({ environmentId, attachments: [image] });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.attachments).toEqual([
      {
        type: "image",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,YWJj",
      },
    ]);
    expect(prepared.pendingAttachmentIds).toEqual([]);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("uploads generic file bytes directly and keeps mixed attachment order", async () => {
    const prepared = await prepareTurnAttachments({ environmentId, attachments: [file, image] });

    expect(mocks.upload).toHaveBeenCalledWith(
      "file:///documents/report.pdf",
      "https://environment.example/api/attachments/upload/signed",
      {
        httpMethod: "POST",
        uploadType: 0,
        headers: { "Content-Type": "application/pdf" },
      },
    );
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.attachments[0]).toEqual({
      type: "file",
      id: MINTED_ID,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    });
    expect(prepared.attachments[1]?.type).toBe("image");
    expect(prepared.pendingAttachmentIds).toEqual([MINTED_ID]);
    expect(prepared.draftAttachments[0]).toEqual({
      ...file,
      uploadedAttachmentId: MINTED_ID,
      uploadEnvironmentId: environmentId,
    });
  });

  it("uses the current connection when an environment reconnects during URL creation", async () => {
    mocks.readAtom
      .mockReturnValueOnce(Option.some({ httpBaseUrl: "https://old-environment.example/" }))
      .mockReturnValueOnce(Option.some({ httpBaseUrl: "https://new-environment.example/" }));

    await prepareTurnAttachments({ environmentId, attachments: [file] });

    expect(mocks.upload).toHaveBeenCalledWith(
      file.fileUri,
      "https://new-environment.example/api/attachments/upload/signed",
      expect.anything(),
    );
  });

  it("uploads a restored draft file from the current iOS document container", async () => {
    const fileName = "33333333-3333-4333-8333-333333333333-report%20%23.pdf";
    const restoredFile = {
      ...file,
      fileUri: `file:///private/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/${fileName}`,
    };
    mocks.documentUri =
      "file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents";
    const currentUri = `${mocks.documentUri}/t3-composer-attachments/${fileName}`;
    mocks.upload.mockImplementation(async (uri: string) => {
      if (uri !== currentUri) {
        throw new Error("File does not exist in the previous application container.");
      }
      return { status: 204, body: "", headers: {} };
    });

    const prepared = await prepareTurnAttachments({
      environmentId,
      attachments: [restoredFile],
    });

    expect(prepared.status).toBe("ready");
    expect(mocks.upload).toHaveBeenCalledWith(
      currentUri,
      "https://environment.example/api/attachments/upload/signed",
      expect.anything(),
    );
  });

  it("adds uploaded file references to durable drafts without changing images", () => {
    expect(
      withUploadedMobileAttachmentReferences({
        environmentId,
        attachments: [file, image],
        uploadedAttachments: [
          {
            type: "file",
            id: "pending-existing-pdf",
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
          },
          {
            type: "image",
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl: image.dataUrl,
          },
        ],
      }),
    ).toEqual([
      {
        ...file,
        uploadedAttachmentId: "pending-existing-pdf",
        uploadEnvironmentId: environmentId,
      },
      image,
    ]);
  });

  it("reuses a pending file upload from a previous outbox attempt", async () => {
    const previouslyUploaded = {
      ...file,
      uploadedAttachmentId: "pending-existing-pdf",
      uploadEnvironmentId: environmentId,
    };

    const prepared = await prepareTurnAttachments({
      environmentId,
      attachments: [previouslyUploaded, image],
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.attachments).toEqual([
      {
        type: "file",
        id: "pending-existing-pdf",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
      },
      {
        type: "image",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,YWJj",
      },
    ]);
    expect(prepared.pendingAttachmentIds).toEqual(["pending-existing-pdf"]);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();
  });

  it("uploads a file again when its saved pending upload has expired", async () => {
    mocks.executeAtomQuery.mockResolvedValueOnce({
      _tag: "Failure",
      error: { _tag: "AssetAttachmentNotFoundError" },
    });
    const previouslyUploaded = {
      ...file,
      uploadedAttachmentId: "pending-expired-pdf",
      uploadEnvironmentId: environmentId,
    };

    const prepared = await prepareTurnAttachments({
      environmentId,
      attachments: [previouslyUploaded],
    });

    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.pendingAttachmentIds).toEqual([MINTED_ID]);
  });

  it("removes pending uploads when the native HTTP request fails", async () => {
    mocks.upload.mockResolvedValue({ status: 500, body: "failed", headers: {} });

    await expect(prepareTurnAttachments({ environmentId, attachments: [file] })).rejects.toThrow(
      "Upload failed for 'report.pdf' (500).",
    );
    expect(removeCallsFor(MINTED_ID)).toBe(1);
  });

  it("keeps a previously persisted upload when a later attachment fails", async () => {
    const previouslyUploaded = {
      ...file,
      id: "file-existing",
      uploadedAttachmentId: "pending-existing-pdf",
      uploadEnvironmentId: environmentId,
    };
    mocks.upload.mockResolvedValue({ status: 500, body: "failed", headers: {} });

    await expect(
      prepareTurnAttachments({ environmentId, attachments: [previouslyUploaded, file] }),
    ).rejects.toThrow("Upload failed for 'report.pdf' (500).");

    expect(removeCallsFor("pending-existing-pdf")).toBe(0);
  });

  it("deletes the minted uploads when the owner abandons the send", async () => {
    const result = await prepareTurnAttachments({
      environmentId,
      attachments: [file],
      persistUploadedReferences: async () => "abandon",
    });

    expect(result.status).toBe("abandoned");
    expect(removeCallsFor(MINTED_ID)).toBe(1);
  });

  it("deletes the minted uploads when persisting the references throws", async () => {
    await expect(
      prepareTurnAttachments({
        environmentId,
        attachments: [file],
        persistUploadedReferences: async () => {
          throw new Error("draft write failed");
        },
      }),
    ).rejects.toThrow("draft write failed");

    expect(removeCallsFor(MINTED_ID)).toBe(1);
  });

  it("skips persisting when every reference is already stored", async () => {
    const previouslyUploaded = {
      ...file,
      uploadedAttachmentId: "pending-existing-pdf",
      uploadEnvironmentId: environmentId,
    };
    const persist = vi.fn(async () => "persisted" as const);

    const prepared = await prepareTurnAttachments({
      environmentId,
      attachments: [previouslyUploaded],
      persistUploadedReferences: persist,
    });

    expect(prepared.status).toBe("ready");
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("releasePendingAttachmentUploads", () => {
  beforeEach(() => {
    mocks.runAtomCommand.mockReset();
  });

  it("retries a failed delete once before reporting it", async () => {
    mocks.runAtomCommand
      .mockResolvedValueOnce({ _tag: "Failure", error: new Error("offline") })
      .mockResolvedValue({ _tag: "Success", value: undefined });

    await expect(
      releasePendingAttachmentUploads(environmentId, ["pending-a"]),
    ).resolves.toBeUndefined();
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(2);
  });

  it("throws when a delete keeps failing so the caller sees the leak", async () => {
    mocks.runAtomCommand.mockResolvedValue({ _tag: "Failure", error: new Error("offline") });

    await expect(releasePendingAttachmentUploads(environmentId, ["pending-a"])).rejects.toThrow(
      "pending-a",
    );
  });

  it("treats an already-deleted pending upload as released", async () => {
    mocks.runAtomCommand.mockResolvedValue({
      _tag: "Failure",
      error: { _tag: "AssetAttachmentNotFoundError" },
    });

    await expect(
      releasePendingAttachmentUploads(environmentId, ["pending-a"]),
    ).resolves.toBeUndefined();
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
  });
});
