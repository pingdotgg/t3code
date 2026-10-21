import * as DocumentText from "../provider/DocumentText.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ChatAttachmentId, type ChatAttachment } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import {
  attachmentIsPendingUpload,
  claimPendingAttachments,
  releaseClaimedAttachments,
} from "./AttachmentClaims.ts";

const layerTest = Layer.mergeAll(NodeServices.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-claims-" })),
  Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
);

const stagePendingUpload = Effect.fn("test.stagePendingUpload")(function* (input: {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const pendingId = createPendingAttachmentId();
  const attachment: ChatAttachment = {
    type: "image",
    id: ChatAttachmentId.make(pendingId!),
    name: input.name,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
  };
  yield* Effect.sync(() => {
    NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${pendingId}.png`), input.bytes);
  });
  return attachment;
});

describe("AttachmentClaims", () => {
  it.effect("copies a pending document's extraction without parsing it again", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const pendingId = createPendingAttachmentId("docx");
      const path = NodePath.join(config.attachmentsDir, pendingId + ".docx");
      NodeFS.writeFileSync(path, "invalid document");
      NodeFS.writeFileSync(path + ".txt", "North calibration: 946");
      const claimed = yield* claimPendingAttachments({
        threadId: "thread-document",
        attachments: [
          {
            type: "file",
            id: ChatAttachmentId.make(pendingId),
            name: "calibration.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sizeBytes: 16,
          },
        ],
      });
      expect(claimed.claimedPaths).toHaveLength(2);
      expect(NodeFS.readFileSync(claimed.claimedPaths[1]!, "utf8")).toBe("North calibration: 946");
      const documents = yield* DocumentText.DocumentText;
      expect(yield* documents.ensure(claimed.claimedPaths[0]!)).toBe(claimed.claimedPaths[1]);
      yield* releaseClaimedAttachments(claimed.claimedPaths);
      expect(NodeFS.existsSync(claimed.claimedPaths[1]!)).toBe(false);
      expect(NodeFS.existsSync(path + ".txt")).toBe(true);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects oversized image batches before copying a pending upload", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "pending.png",
        bytes: new Uint8Array([1]),
        mimeType: "image/png",
      });
      const images: ChatAttachment[] = Array.from({ length: 9 }, (_, index) => ({
        type: "image",
        id: ChatAttachmentId.make(`existing-image-${index}`),
        name: `${index}.png`,
        mimeType: "image/png",
        sizeBytes: 10 * 1024 * 1024,
      }));
      const result = yield* Effect.exit(
        claimPendingAttachments({
          threadId: "thread-image-budget",
          attachments: [pending, ...images],
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(String(result.cause)).toContain("80 MiB");
      const config = yield* ServerConfig.ServerConfig;
      expect(NodeFS.readdirSync(config.attachmentsDir)).toHaveLength(1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("claims a pending upload into the thread store and rewrites the id", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "screenshot.png",
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: "image/png",
      });
      const config = yield* ServerConfig.ServerConfig;

      const claimed = yield* claimPendingAttachments({
        threadId: "thread-claims-1",
        attachments: [pending],
      });

      expect(claimed.attachments).toHaveLength(1);
      const attachment = claimed.attachments[0]!;
      expect(attachmentIsPendingUpload(attachment)).toBe(false);
      expect(parseThreadSegmentFromAttachmentId(attachment.id)).toBe("thread-claims-1");
      expect(claimed.claimedPaths).toHaveLength(1);
      expect(NodeFS.existsSync(claimed.claimedPaths[0]!)).toBe(true);
      const pendingFiles = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("pending-"),
      );
      expect(pendingFiles).toHaveLength(1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects a size mismatch and cleans up earlier claims from the batch", () =>
    Effect.gen(function* () {
      const good = yield* stagePendingUpload({
        name: "one.png",
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: "image/png",
      });
      const staged = yield* stagePendingUpload({
        name: "two.png",
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: "image/png",
      });
      const mismatched = { ...staged, sizeBytes: 999 };
      const config = yield* ServerConfig.ServerConfig;

      const result = yield* Effect.exit(
        claimPendingAttachments({
          threadId: "thread-claims-4",
          attachments: [good, mismatched],
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const error = result.cause;
        expect(String(error)).toContain("stored size does not match");
      }
      const claimedFiles = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-claims-4-"),
      );
      expect(claimedFiles).toHaveLength(0);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects duplicate attachment ids before copying anything", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "dupe.png",
        bytes: new Uint8Array([5, 5, 5]),
        mimeType: "image/png",
      });
      const config = yield* ServerConfig.ServerConfig;

      const result = yield* Effect.exit(
        claimPendingAttachments({
          threadId: "thread-claims-dupe",
          attachments: [pending, pending],
        }),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.cause)).toContain("Duplicate attachment ids");
      }
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
          entry.startsWith("thread-claims-dupe-"),
        ),
      ).toHaveLength(0);
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((entry) => entry.startsWith("pending-")),
      ).toHaveLength(1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rolls back a copy that finishes after the claim is interrupted", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "interrupt.png",
        bytes: new Uint8Array([7, 7, 7]),
        mimeType: "image/png",
      });
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      const copyArgs = yield* Deferred.make<readonly [string, string]>();
      const copyDone = yield* Deferred.make<void>();
      // fs.copyFile cannot be cancelled: the write runs on a separate fiber
      // while the claim's copyFile only observes its completion, so the file
      // still lands after the awaiting effect is interrupted.
      const gatedFileSystem = Object.create(fileSystem, {
        copyFile: {
          value: (from: string, to: string) =>
            Deferred.succeed(copyArgs, [from, to] as const).pipe(
              Effect.andThen(Deferred.await(copyDone)),
            ),
        },
      }) as FileSystem.FileSystem;

      const claimFiber = yield* claimPendingAttachments({
        threadId: "thread-claims-interrupt",
        attachments: [pending],
      }).pipe(Effect.provideService(FileSystem.FileSystem, gatedFileSystem), Effect.forkChild);

      const [sourcePath, claimedPath] = yield* Deferred.await(copyArgs);
      claimFiber.interruptUnsafe();
      const writer = yield* fileSystem
        .copyFile(sourcePath, claimedPath)
        .pipe(Effect.ensuring(Deferred.succeed(copyDone, undefined)), Effect.forkChild);

      const exit = yield* Fiber.await(claimFiber);
      const writerExit = yield* Fiber.await(writer);
      expect(Exit.isSuccess(writerExit)).toBe(true);

      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(NodeFS.existsSync(claimedPath)).toBe(false);
      expect(NodeFS.existsSync(sourcePath)).toBe(true);
      expect(
        NodeFS.readdirSync(config.attachmentsDir).filter((entry) => entry.startsWith("pending-")),
      ).toHaveLength(1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rolls back an extracted sidecar published while the claim is interrupted", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "interrupt.png",
        bytes: new Uint8Array([7]),
        mimeType: "image/png",
      });
      const started = yield* Deferred.make<string>();
      const publish = yield* Deferred.make<void>();
      const fileSystem = yield* FileSystem.FileSystem;
      const claimFiber = yield* claimPendingAttachments({
        threadId: "thread-extraction-interrupt",
        attachments: [pending],
      }).pipe(
        Effect.provideService(
          DocumentText.DocumentText,
          DocumentText.DocumentText.of({
            ensure: (path) =>
              Deferred.succeed(started, path).pipe(
                Effect.andThen(Deferred.await(publish)),
                Effect.andThen(fileSystem.writeFileString(path + ".txt", "extracted")),
                Effect.as(path + ".txt"),
                Effect.orDie,
                Effect.uninterruptible,
              ),
          }),
        ),
        Effect.forkChild,
      );
      const claimedPath = yield* Deferred.await(started);
      claimFiber.interruptUnsafe();
      yield* Deferred.succeed(publish, undefined);
      expect(Exit.hasInterrupts(yield* Fiber.await(claimFiber))).toBe(true);
      expect(NodeFS.existsSync(claimedPath)).toBe(false);
      expect(NodeFS.existsSync(claimedPath + ".txt")).toBe(false);
      const config = yield* ServerConfig.ServerConfig;
      expect(NodeFS.readdirSync(config.attachmentsDir)).toHaveLength(1);
    }).pipe(Effect.provide(layerTest)),
  );
});
