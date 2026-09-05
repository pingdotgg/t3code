// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  MessageId,
  RunId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import {
  attachmentIsPendingUpload,
  claimPendingAttachments,
  dispatchWithClaimedAttachments,
  releaseClaimedAttachments,
} from "./AttachmentClaims.ts";

const testLayer = Layer.mergeAll(NodeServices.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-attachment-claims-" })),
  Layer.provideMerge(NodeServices.layer),
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

const stagePendingFileUpload = Effect.fn("test.stagePendingFileUpload")(function* (input: {
  readonly name: string;
  readonly bytes: Uint8Array;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const pendingId = createPendingAttachmentId("pdf");
  const attachment: ChatAttachment = {
    type: "file",
    id: ChatAttachmentId.make(pendingId),
    name: input.name,
    mimeType: "application/pdf",
    sizeBytes: input.bytes.byteLength,
  };
  yield* Effect.sync(() => {
    NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${pendingId}.pdf`), input.bytes);
  });
  return attachment;
});

function queuedEditCommand(
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): OrchestrationV2Command {
  return {
    type: "queued-run.edit",
    commandId: CommandId.make("command-queued-edit"),
    threadId: ThreadId.make("thread-queued-edit"),
    runId: RunId.make("run-queued-edit"),
    text: "Updated queued message",
    ...(attachments === undefined ? {} : { attachments }),
  };
}

function messageDispatchCommand(
  attachments: ReadonlyArray<ChatAttachment>,
): OrchestrationV2Command {
  return {
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command-message-dispatch"),
    threadId: ThreadId.make("thread-message-dispatch"),
    messageId: MessageId.make("message-dispatch"),
    text: "New message",
    attachments,
    dispatchMode: { type: "start_immediately" },
  };
}

describe("AttachmentClaims", () => {
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
      // The pending copy stays behind as the retry source.
      const pendingFiles = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("pending-"),
      );
      expect(pendingFiles).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("passes already-claimed attachments through untouched", () =>
    Effect.gen(function* () {
      const stored: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make("thread-claims-2-00000000-0000-4000-8000-000000000001"),
        name: "existing.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const claimed = yield* claimPendingAttachments({
        threadId: "thread-claims-2",
        attachments: [stored],
      });
      expect(claimed.attachments[0]).toBe(stored);
      expect(claimed.claimedPaths).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a pending ref whose staged file is missing", () =>
    Effect.gen(function* () {
      const missing: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make(createPendingAttachmentId()!),
        name: "gone.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const result = yield* Effect.exit(
        claimPendingAttachments({ threadId: "thread-claims-3", attachments: [missing] }),
      );
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(testLayer)),
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
      // The successfully claimed first attachment was rolled back.
      const claimedFiles = NodeFS.readdirSync(config.attachmentsDir).filter((entry) =>
        entry.startsWith("thread-claims-4-"),
      );
      expect(claimedFiles).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("releaseClaimedAttachments removes claimed copies best-effort", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "release.png",
        bytes: new Uint8Array([9, 9]),
        mimeType: "image/png",
      });
      const claimed = yield* claimPendingAttachments({
        threadId: "thread-claims-5",
        attachments: [pending],
      });
      expect(NodeFS.existsSync(claimed.claimedPaths[0]!)).toBe(true);
      yield* releaseClaimedAttachments(claimed.claimedPaths);
      expect(NodeFS.existsSync(claimed.claimedPaths[0]!)).toBe(false);
      // Releasing again is a no-op, not an error.
      yield* releaseClaimedAttachments(claimed.claimedPaths);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("treats malformed ids as non-pending and passes them through", () =>
    Effect.gen(function* () {
      // Not a parseable pending ref: nothing to claim, so the ref flows
      // through unchanged and downstream delivery decides what to do with it.
      const bogus: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make("pending-not-a-uuid"),
        name: "weird.png",
        mimeType: "image/png",
        sizeBytes: 1,
      };
      const claimed = yield* claimPendingAttachments({
        threadId: "thread-claims-6",
        attachments: [bogus],
      });
      expect(claimed.attachments[0]).toBe(bogus);
      expect(claimed.claimedPaths).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("claims pending queued-edit files and preserves existing attachments", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingFileUpload({
        name: "report.pdf",
        bytes: new Uint8Array([1, 2, 3, 4]),
      });
      const existing: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make("thread-queued-edit-00000000-0000-4000-8000-000000000001"),
        name: "existing.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const dispatched = yield* Ref.make<OrchestrationV2Command | null>(null);

      yield* dispatchWithClaimedAttachments(queuedEditCommand([existing, pending]), (command) =>
        Ref.set(dispatched, command),
      );

      const command = yield* Ref.get(dispatched);
      expect(command?.type).toBe("queued-run.edit");
      if (command?.type !== "queued-run.edit") return;
      expect(command.attachments?.[0]).toBe(existing);
      expect(attachmentIsPendingUpload(command.attachments![1]!)).toBe(false);
      expect(parseThreadSegmentFromAttachmentId(command.attachments![1]!.id)).toBe(
        "thread-queued-edit",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("continues to claim pending message-dispatch attachments", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingUpload({
        name: "message.png",
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: "image/png",
      });
      const dispatched = yield* Ref.make<OrchestrationV2Command | null>(null);

      yield* dispatchWithClaimedAttachments(messageDispatchCommand([pending]), (command) =>
        Ref.set(dispatched, command),
      );

      const command = yield* Ref.get(dispatched);
      expect(command?.type).toBe("message.dispatch");
      if (command?.type !== "message.dispatch") return;
      expect(attachmentIsPendingUpload(command.attachments[0]!)).toBe(false);
      expect(parseThreadSegmentFromAttachmentId(command.attachments[0]!.id)).toBe(
        "thread-message-dispatch",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes queued-edit claimed copies when dispatch fails", () =>
    Effect.gen(function* () {
      const pending = yield* stagePendingFileUpload({
        name: "retry.pdf",
        bytes: new Uint8Array([5, 6, 7, 8]),
      });
      const config = yield* ServerConfig.ServerConfig;

      const result = yield* Effect.exit(
        dispatchWithClaimedAttachments(queuedEditCommand([pending]), () =>
          Effect.fail("dispatch rejected"),
        ),
      );

      expect(result._tag).toBe("Failure");
      const files = NodeFS.readdirSync(config.attachmentsDir);
      expect(files.filter((file) => file.startsWith("thread-queued-edit-"))).toHaveLength(0);
      expect(files.filter((file) => file.startsWith("pending-"))).toHaveLength(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("leaves attachment-free queued edits unchanged", () =>
    Effect.gen(function* () {
      const original = queuedEditCommand(undefined);
      const dispatched = yield* Ref.make<OrchestrationV2Command | null>(null);

      yield* dispatchWithClaimedAttachments(original, (command) => Ref.set(dispatched, command));

      expect(yield* Ref.get(dispatched)).toBe(original);
    }).pipe(Effect.provide(testLayer)),
  );
});
