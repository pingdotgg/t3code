import { describe, expect, it, vi } from "@effect/vitest";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import type { ResolvedSharePayload, SharePayload } from "expo-sharing";

import {
  buildIncomingShareDraft,
  hasIncomingShareContent,
  isShareFileUriUnderOwnedRoots,
  selectIncomingShareAttachments,
  selectIncomingShareAttachmentsForServer,
} from "./incoming-share-model";

describe("incoming native shares", () => {
  it("converts shared text, URLs, and images into a durable composer draft", async () => {
    const image: SharePayload = {
      shareType: "image",
      value: "file:///shared/Screenshot.png",
      mimeType: "image/png",
    };
    const payloads: SharePayload[] = [
      { shareType: "text", value: "Please explain this error" },
      { shareType: "url", value: "https://example.com/issue/1" },
      { shareType: "text", value: "Please explain this error" },
      image,
    ];
    const resolvedImage: ResolvedSharePayload = {
      ...image,
      contentUri: image.value,
      contentType: "image",
      contentMimeType: "image/png",
      contentSize: 3,
      originalName: "Screenshot.png",
    };
    const removeOwnedFile = vi.fn(() => Promise.resolve());

    const result = await buildIncomingShareDraft({
      id: "share-1",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads,
      resolvedPayloads: [resolvedImage],
      fileReader: {
        readBase64: async () => "YWJj",
        removeOwnedFile,
      },
    });

    expect(result).toEqual({
      schemaVersion: 1,
      id: "share-1",
      createdAt: "2026-07-15T10:00:00.000Z",
      text: "Please explain this error\n\nhttps://example.com/issue/1",
      attachments: [
        {
          id: "share-1:image:3",
          type: "image",
          name: "Screenshot.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataUrl: "data:image/png;base64,YWJj",
          previewUri: "data:image/png;base64,YWJj",
        },
      ],
      warnings: [],
    });
    expect(removeOwnedFile).toHaveBeenCalledWith(image.value);
    expect(hasIncomingShareContent(result)).toBe(true);
  });

  it("skips oversized images and releases the temporary native file", async () => {
    const image: SharePayload = {
      shareType: "image",
      value: "file:///shared/huge.png",
      mimeType: "image/png",
    };
    const readBase64 = vi.fn(async () => "unused");
    const removeOwnedFile = vi.fn(() => Promise.resolve());

    const result = await buildIncomingShareDraft({
      id: "share-2",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads: [image],
      resolvedPayloads: [
        {
          ...image,
          contentUri: image.value,
          contentType: "image",
          contentMimeType: "image/png",
          contentSize: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
          originalName: "huge.png",
        },
      ],
      fileReader: { readBase64, removeOwnedFile },
    });

    expect(result.attachments).toEqual([]);
    expect(result.warnings).toEqual(["'huge.png' exceeds the 10 MB attachment limit."]);
    expect(readBase64).not.toHaveBeenCalled();
    expect(removeOwnedFile).toHaveBeenCalledWith(image.value);
    expect(hasIncomingShareContent(result)).toBe(false);
  });

  it("keeps a shared PDF on disk without converting its contents to base64", async () => {
    const file: SharePayload = {
      shareType: "file",
      value: "file:///shared/report.pdf",
      mimeType: "application/pdf",
    };
    const readBase64 = vi.fn(async () => "unused");
    const persistFile = vi.fn(async () => "file:///documents/report.pdf");
    const removeOwnedFile = vi.fn(async (_uri: string) => undefined);

    const result = await buildIncomingShareDraft({
      id: "share-report",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads: [file],
      resolvedPayloads: [
        {
          ...file,
          contentUri: file.value,
          contentType: "file",
          contentMimeType: "application/pdf",
          contentSize: 42,
          originalName: "report.pdf",
        },
      ],
      fileReader: { readBase64, persistFile, removeOwnedFile },
    });

    expect(result.attachments).toEqual([
      {
        id: "share-report:file:0",
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        fileUri: "file:///documents/report.pdf",
      },
    ]);
    expect(readBase64).not.toHaveBeenCalled();
    expect(persistFile).toHaveBeenCalledWith(file.value, "report.pdf");
    expect(removeOwnedFile).toHaveBeenCalledWith(file.value);
  });

  it("rejects shared files that exceed the generic attachment limit", async () => {
    const file: SharePayload = {
      shareType: "file",
      value: "file:///shared/huge.zip",
      mimeType: "application/zip",
    };
    const persistFile = vi.fn(async () => "file:///documents/huge.zip");
    const removeOwnedFile = vi.fn(async () => undefined);

    const result = await buildIncomingShareDraft({
      id: "share-huge",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads: [file],
      resolvedPayloads: [
        {
          ...file,
          contentUri: file.value,
          contentType: "file",
          contentMimeType: "application/zip",
          contentSize: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
          originalName: "huge.zip",
        },
      ],
      fileReader: {
        readBase64: async () => "unused",
        persistFile,
        removeOwnedFile,
      },
    });

    expect(result.attachments).toEqual([]);
    expect(result.warnings).toEqual(["'huge.zip' exceeds the 50 MB attachment limit."]);
    expect(persistFile).not.toHaveBeenCalled();
    expect(removeOwnedFile).toHaveBeenCalledWith(file.value);
  });

  it.each([
    { value: "file:///shared/clip.MOV", mimeType: "video/quicktime", originalName: "clip.MOV" },
    { value: "content://media/videos/12", mimeType: "video/mp4", originalName: "clip.mp4" },
  ])("imports a shared video from $value without reading it as an image", async (video) => {
    const sizeBytes = 20 * 1024 * 1024;
    const fileUri = `file:///documents/${video.originalName}`;
    const readBase64 = vi.fn(async () => "unused");
    const persistFile = vi.fn(async () => fileUri);
    const removeOwnedFile = vi.fn(async () => undefined);

    const result = await buildIncomingShareDraft({
      id: "share-video",
      createdAt: "2026-08-30T10:00:00.000Z",
      payloads: [{ ...video, shareType: "video" }],
      resolvedPayloads: [],
      fileReader: { readBase64, persistFile, readSize: async () => sizeBytes, removeOwnedFile },
    });

    expect(result.warnings).toEqual([]);
    expect(result.attachments).toEqual([
      {
        id: "share-video:file:0",
        type: "file",
        name: video.originalName,
        mimeType: video.mimeType,
        sizeBytes,
        fileUri,
      },
    ]);
    expect(readBase64).not.toHaveBeenCalled();
    expect(removeOwnedFile).toHaveBeenCalledWith(video.value);
    expect(
      selectIncomingShareAttachments({
        attachments: result.attachments,
        maxFileAttachmentBytes: 50 * 1024 * 1024,
      }),
    ).toEqual({ attachments: result.attachments, warnings: [] });
    expect(
      selectIncomingShareAttachments({
        attachments: result.attachments,
        maxFileAttachmentBytes: 10 * 1024 * 1024,
      }),
    ).toEqual({
      attachments: [],
      warnings: [`'${video.originalName}' exceeds the 10 MB attachment limit.`],
    });
  });

  it("reports an unreadable shared file without calling it oversized", async () => {
    const file: SharePayload = {
      shareType: "file",
      value: "file:///shared/empty.txt",
      mimeType: "text/plain",
    };

    const result = await buildIncomingShareDraft({
      id: "share-empty",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads: [file],
      resolvedPayloads: [],
      fileReader: {
        readBase64: async () => "unused",
        readSize: async () => 0,
        removeOwnedFile: async () => undefined,
      },
    });

    expect(result.attachments).toEqual([]);
    expect(result.warnings).toEqual(["'empty.txt' is empty or could not be read."]);
  });

  it("reads an Android content URI's size after copying it into app-owned storage", async () => {
    const file: SharePayload = {
      shareType: "file",
      value: "content://shared/report",
      mimeType: "application/pdf",
    };
    const persistFile = vi.fn(async () => "file:///documents/report.pdf");
    const readSize = vi.fn(async (uri: string) => (uri.startsWith("content:") ? null : 42));

    const result = await buildIncomingShareDraft({
      id: "share-android-report",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads: [file],
      resolvedPayloads: [],
      fileReader: {
        readBase64: async () => "unused",
        persistFile,
        readSize,
        removeOwnedFile: async () => undefined,
      },
    });

    expect(result.attachments).toEqual([
      {
        id: "share-android-report:file:0",
        type: "file",
        name: "report",
        mimeType: "application/pdf",
        sizeBytes: 42,
        fileUri: "file:///documents/report.pdf",
      },
    ]);
    expect(readSize.mock.calls).toEqual([
      ["content://shared/report"],
      ["file:///documents/report.pdf"],
    ]);
  });

  it("records the stored copy's measured size when a content URI under-reports", async () => {
    const file: SharePayload = {
      shareType: "file",
      value: "content://shared/report",
      mimeType: "application/pdf",
    };
    // The source claims 42 bytes but the stored copy measures 4200.
    const persistFile = vi.fn(async () => "file:///documents/report.pdf");
    const readSize = vi.fn(async (uri: string) => (uri.startsWith("content:") ? 42 : 4200));

    const result = await buildIncomingShareDraft({
      id: "share-android-report",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads: [file],
      resolvedPayloads: [],
      fileReader: {
        readBase64: async () => "unused",
        persistFile,
        readSize,
        removeOwnedFile: async () => undefined,
      },
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.sizeBytes).toBe(4200);
  });

  it("treats a zero-length Android content URI as unknown until its copy is measured", async () => {
    const file: SharePayload = {
      shareType: "file",
      value: "content://shared/report",
      mimeType: "application/pdf",
    };

    const result = await buildIncomingShareDraft({
      id: "share-zero-metadata",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads: [file],
      resolvedPayloads: [],
      fileReader: {
        readBase64: async () => "unused",
        persistFile: async () => "file:///documents/report.pdf",
        readSize: async (uri) => (uri.startsWith("content:") ? 0 : 42),
        removeOwnedFile: async () => undefined,
      },
    });

    expect(result.attachments[0]?.sizeBytes).toBe(42);
    expect(result.warnings).toEqual([]);
  });

  it("rejects a shared file whose persisted copy measures empty and releases the copy", async () => {
    const file: SharePayload = {
      shareType: "file",
      value: "content://shared/report",
      mimeType: "application/pdf",
    };
    const persistedUri = "file:///documents/report.pdf";
    const removeOwnedFile = vi.fn(async (_uri: string) => undefined);

    const result = await buildIncomingShareDraft({
      id: "share-empty-copy",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads: [file],
      resolvedPayloads: [],
      fileReader: {
        readBase64: async () => "unused",
        persistFile: async () => persistedUri,
        // The source claims 42 bytes but the stored copy measures zero: the
        // copy is what uploads, so its measured size wins and the empty file
        // is rejected instead of shipped with a made-up size.
        readSize: async (uri) => (uri.startsWith("content:") ? 42 : 0),
        removeOwnedFile,
      },
    });

    expect(result.attachments).toEqual([]);
    expect(result.warnings).toEqual(["'report' is empty or could not be read."]);
    expect(removeOwnedFile.mock.calls.map(([uri]) => uri)).toContain(persistedUri);
  });

  it("keeps the Android display name without copying the file into the Expo cache", async () => {
    const file = {
      shareType: "file" as const,
      value: "content://shared/12345",
      mimeType: "application/pdf",
      originalName: "quarterly-report.pdf",
    };

    const result = await buildIncomingShareDraft({
      id: "share-named-report",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads: [file],
      resolvedPayloads: [],
      fileReader: {
        readBase64: async () => "unused",
        readSize: async () => 42,
        persistFile: async (_uri, name) => `file:///documents/${name}`,
        removeOwnedFile: async () => undefined,
      },
    });

    expect(result.attachments).toEqual([
      {
        id: "share-named-report:file:0",
        type: "file",
        name: "quarterly-report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
        fileUri: "file:///documents/quarterly-report.pdf",
      },
    ]);
  });

  it("keeps a no-copy file source that the returned attachment still owns", async () => {
    const sourceUri = "file:///documents/report.pdf";
    const removeOwnedFile = vi.fn(async () => undefined);

    const result = await buildIncomingShareDraft({
      id: "share-no-copy",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads: [{ shareType: "file", value: sourceUri, mimeType: "application/pdf" }],
      resolvedPayloads: [],
      fileReader: {
        readBase64: async () => "unused",
        readSize: async () => 42,
        removeOwnedFile,
      },
    });

    expect(result.attachments[0]).toMatchObject({ type: "file", fileUri: sourceUri });
    expect(removeOwnedFile).not.toHaveBeenCalled();
  });

  it("keeps a persisted copy and releases distinct temporary source URIs", async () => {
    const payloadUri = "content://shared/report";
    const resolvedUri = "file:///cache/report.pdf";
    const persistedUri = "file:///documents/report.pdf";
    const removeOwnedFile = vi.fn(async (_uri: string) => undefined);

    const result = await buildIncomingShareDraft({
      id: "share-copy",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads: [{ shareType: "file", value: payloadUri, mimeType: "application/pdf" }],
      resolvedPayloads: [
        {
          shareType: "file",
          value: payloadUri,
          mimeType: "application/pdf",
          contentUri: resolvedUri,
          contentType: "file",
          contentMimeType: "application/pdf",
          contentSize: 42,
          originalName: "report.pdf",
        },
      ],
      fileReader: {
        readBase64: async () => "unused",
        readSize: async () => 42,
        persistFile: async () => persistedUri,
        removeOwnedFile,
      },
    });

    expect(result.attachments[0]).toMatchObject({ type: "file", fileUri: persistedUri });
    expect(removeOwnedFile.mock.calls.map(([uri]) => uri)).toEqual([resolvedUri, payloadUri]);
  });

  it("keeps images and rejects shared files on servers without file support", () => {
    const image = {
      id: "image-1",
      type: "image" as const,
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,YWJj",
      previewUri: "data:image/png;base64,YWJj",
    };
    const file = {
      id: "file-1",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: "file:///documents/report.pdf",
    };

    expect(
      selectIncomingShareAttachments({
        attachments: [image, file],
        maxFileAttachmentBytes: null,
      }),
    ).toEqual({
      attachments: [image],
      warnings: ["'report.pdf' was skipped because this server does not support files."],
    });
  });

  it("uses the destination server's attachment limit in share warnings", () => {
    const file = {
      id: "file-1",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 6 * 1024 * 1024,
      fileUri: "file:///documents/report.pdf",
    };

    expect(
      selectIncomingShareAttachments({
        attachments: [file],
        maxFileAttachmentBytes: 5 * 1024 * 1024,
      }),
    ).toEqual({
      attachments: [],
      warnings: ["'report.pdf' exceeds the 5 MB attachment limit."],
    });
  });

  it("uses current server support and limits when selecting a reserved share", () => {
    const file = {
      id: "file-1",
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 6 * 1024 * 1024,
      fileUri: "file:///documents/report.pdf",
    };

    expect(
      selectIncomingShareAttachmentsForServer({ attachments: [file], serverConfig: null }),
    ).toEqual({ status: "pending" });
    expect(
      selectIncomingShareAttachmentsForServer({
        attachments: [file],
        serverConfig: { environment: { capabilities: { attachmentUploads: true } } },
      }),
    ).toMatchObject({ status: "ready", attachments: [] });
    expect(
      selectIncomingShareAttachmentsForServer({
        attachments: [file],
        serverConfig: {
          environment: {
            capabilities: {
              attachmentUploads: true,
              fileAttachments: { maxUploadBytes: 5 * 1024 * 1024 },
            },
          },
        },
      }),
    ).toMatchObject({ status: "ready", attachments: [] });
    expect(
      selectIncomingShareAttachmentsForServer({
        attachments: [file],
        serverConfig: {
          environment: {
            capabilities: {
              attachmentUploads: true,
              fileAttachments: { maxUploadBytes: 10 * 1024 * 1024 },
            },
          },
        },
      }),
    ).toMatchObject({ status: "ready", attachments: [file] });
  });

  it("releases every temporary file when a share exceeds the attachment limit", async () => {
    const payloads = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, (_, index) => ({
      shareType: "image" as const,
      value: `file:///shared/${index}.png`,
      mimeType: "image/png",
    }));
    const removeOwnedFile = vi.fn(() => Promise.resolve());
    const readBase64 = vi.fn(async () => "YWJj");

    const result = await buildIncomingShareDraft({
      id: "share-3",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads,
      resolvedPayloads: [],
      fileReader: { readBase64, removeOwnedFile },
    });

    expect(result.attachments).toHaveLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
    expect(result.warnings).toEqual([
      `Only the first ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} shared images were attached.`,
    ]);
    expect(readBase64).toHaveBeenCalledTimes(PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
    expect(removeOwnedFile).toHaveBeenCalledTimes(payloads.length);
  });

  it("maps duplicate image payloads to distinct resolved files", async () => {
    const duplicate: SharePayload = {
      shareType: "image",
      value: "content://shared/screenshot",
      mimeType: "image/png",
    };
    const resolvedPayloads: ResolvedSharePayload[] = [
      {
        ...duplicate,
        contentUri: "file:///cache/first.png",
        contentType: "image",
        contentMimeType: "image/png",
        contentSize: 3,
        originalName: "first.png",
      },
      {
        ...duplicate,
        contentUri: "file:///cache/second.png",
        contentType: "image",
        contentMimeType: "image/png",
        contentSize: 3,
        originalName: "second.png",
      },
    ];
    const readBase64 = vi.fn(async (uri: string) =>
      uri.includes("first") ? "Zmlyc3Q=" : "c2Vjb25k",
    );
    const removeOwnedFile = vi.fn(async () => undefined);

    const result = await buildIncomingShareDraft({
      id: "share-duplicates",
      createdAt: "2026-07-16T08:00:00.000Z",
      payloads: [duplicate, duplicate],
      resolvedPayloads,
      fileReader: { readBase64, removeOwnedFile },
    });

    expect(readBase64.mock.calls.map(([uri]) => uri)).toEqual([
      "file:///cache/first.png",
      "file:///cache/second.png",
    ]);
    expect(result.attachments.map((attachment) => attachment.name)).toEqual([
      "first.png",
      "second.png",
    ]);
    expect(removeOwnedFile).toHaveBeenCalledWith("file:///cache/first.png");
    expect(removeOwnedFile).toHaveBeenCalledWith("file:///cache/second.png");
  });

  it("keeps imported content when temporary-file cleanup fails", async () => {
    const image: SharePayload = {
      shareType: "image",
      value: "file:///shared/screenshot.png",
      mimeType: "image/png",
    };

    const result = await buildIncomingShareDraft({
      id: "share-cleanup-failure",
      createdAt: "2026-07-16T08:00:00.000Z",
      payloads: [image],
      resolvedPayloads: [],
      fileReader: {
        readBase64: async () => "YWJj",
        removeOwnedFile: async () => {
          throw new Error("file is busy");
        },
      },
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("releases a persisted copy when a later step fails to read it", async () => {
    const file: SharePayload = {
      shareType: "file",
      value: "content://shared/report",
      mimeType: "application/pdf",
    };
    const persistedUri = "file:///documents/t3-composer-attachments/report.pdf";
    const removeOwnedFile = vi.fn(async (_uri: string) => undefined);

    const result = await buildIncomingShareDraft({
      id: "share-persist-leak",
      createdAt: "2026-07-16T08:00:00.000Z",
      payloads: [file],
      resolvedPayloads: [],
      fileReader: {
        readBase64: async () => "unused",
        persistFile: async () => persistedUri,
        readSize: async (uri) => {
          if (uri === persistedUri) {
            throw new Error("read failed");
          }
          return null;
        },
        removeOwnedFile,
      },
    });

    expect(result.attachments).toEqual([]);
    expect(result.warnings).toEqual(["read failed"]);
    expect(removeOwnedFile.mock.calls.map(([uri]) => uri)).toContain(persistedUri);
  });
});

describe("share cleanup ownership", () => {
  const ownedRoots = [
    "file:///var/mobile/Containers/Data/Application/APP/Documents/",
    "file:///var/mobile/Containers/Shared/AppGroup/GROUP",
  ];

  it("allows deleting files inside the app's own directories", () => {
    expect(
      isShareFileUriUnderOwnedRoots(
        "file:///var/mobile/Containers/Shared/AppGroup/GROUP/shared.pdf",
        ownedRoots,
      ),
    ).toBe(true);
  });

  it("treats /private/var and /var as the same iOS location", () => {
    expect(
      isShareFileUriUnderOwnedRoots(
        "file:///private/var/mobile/Containers/Shared/AppGroup/GROUP/shared.pdf",
        ownedRoots,
      ),
    ).toBe(true);
    expect(
      isShareFileUriUnderOwnedRoots(
        "file:///var/mobile/Containers/Data/Application/APP/Documents/t3-composer-attachments/a.pdf",
        ["file:///private/var/mobile/Containers/Data/Application/APP/Documents/"],
      ),
    ).toBe(true);
  });

  it("refuses to delete a sender-owned open-in-place document", () => {
    expect(
      isShareFileUriUnderOwnedRoots(
        "file:///private/var/mobile/Containers/Shared/FileProvider/OTHER/File%20Provider%20Storage/taxes.pdf",
        ownedRoots,
      ),
    ).toBe(false);
  });

  it("refuses traversal segments that escape an owned root", () => {
    // An encoded separator survives URL normalization: "..%2F.." decodes to
    // "../..", so the lexical check must reject it before containment.
    expect(
      isShareFileUriUnderOwnedRoots(
        "file:///var/mobile/Containers/Shared/AppGroup/GROUP/..%2F..%2FsenderDoc.pdf",
        ownedRoots,
      ),
    ).toBe(false);
    expect(
      isShareFileUriUnderOwnedRoots(
        "file:///var/mobile/Containers/Shared/AppGroup/GROUP/../senderDoc.pdf",
        ownedRoots,
      ),
    ).toBe(false);
    expect(
      isShareFileUriUnderOwnedRoots(
        "file:///var/mobile/Containers/Shared/AppGroup/GROUP/%2e%2e/senderDoc.pdf",
        ownedRoots,
      ),
    ).toBe(false);
  });

  it("refuses non-file URIs and the owned root itself", () => {
    expect(isShareFileUriUnderOwnedRoots("content://shared/report", ownedRoots)).toBe(false);
    expect(
      isShareFileUriUnderOwnedRoots(
        "file:///var/mobile/Containers/Shared/AppGroup/GROUP",
        ownedRoots,
      ),
    ).toBe(false);
  });
});
