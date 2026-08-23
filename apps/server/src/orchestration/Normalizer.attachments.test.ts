// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type ClientOrchestrationCommand,
  CommandId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const testLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-attachments-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const attachmentUuid = "00000000-0000-4000-8000-0000000000aa";

function turnStartCommand(input: {
  readonly threadId?: string;
  readonly attachments: ReadonlyArray<
    | { readonly id: string; readonly sizeBytes: number }
    | { readonly dataUrl: string; readonly sizeBytes: number }
  >;
}): ClientOrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("command-1"),
    threadId: ThreadId.make(input.threadId ?? "thread-1"),
    message: {
      messageId: MessageId.make("message-1"),
      role: "user",
      text: "look at this",
      attachments: input.attachments.map((attachment) => ({
        type: "image" as const,
        name: "screenshot.png",
        mimeType: "image/png",
        ...attachment,
      })),
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("normalizeDispatchCommand attachments", () => {
  it.effect("preserves inline image attachments from existing mobile clients", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const normalized = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [{ dataUrl: "data:image/png;base64,cGl4ZWxz", sizeBytes: 6 }],
        }),
      );
      if (normalized.type !== "thread.turn.start") {
        throw new Error("Expected a thread.turn.start command.");
      }

      const attachment = normalized.message.attachments[0]!;
      expect(attachment.id.startsWith("thread-1-")).toBe(true);
      expect(
        NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${attachment.id}.png`)),
      ).toEqual(Buffer.from("pixels"));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("claims uploaded attachments while retaining a retryable pending copy", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const bytes = Buffer.from("pixels");
      const pendingPath = NodePath.join(config.attachmentsDir, `pending-${attachmentUuid}.png`);
      NodeFS.writeFileSync(pendingPath, bytes);

      const normalized = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [{ id: `pending-${attachmentUuid}`, sizeBytes: bytes.byteLength }],
        }),
      );
      if (normalized.type !== "thread.turn.start") {
        throw new Error("Expected a thread.turn.start command.");
      }

      expect(normalized.message.attachments[0]?.id).toBe(`thread-1-${attachmentUuid}`);
      expect(NodeFS.existsSync(pendingPath)).toBe(true);
      expect(
        NodeFS.existsSync(NodePath.join(config.attachmentsDir, `thread-1-${attachmentUuid}.png`)),
      ).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("normalizes inline and uploaded attachments in the same turn", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      NodeFS.writeFileSync(
        NodePath.join(config.attachmentsDir, `pending-${attachmentUuid}.png`),
        Buffer.from("pixels"),
      );

      const normalized = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [
            { dataUrl: "data:image/png;base64,cGl4ZWxz", sizeBytes: 6 },
            { id: `pending-${attachmentUuid}`, sizeBytes: 6 },
          ],
        }),
      );
      if (normalized.type !== "thread.turn.start") {
        throw new Error("Expected a thread.turn.start command.");
      }

      expect(normalized.message.attachments).toHaveLength(2);
      expect(normalized.message.attachments[1]?.id).toBe(`thread-1-${attachmentUuid}`);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retries a failed bootstrap with a fresh thread id", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const bytes = Buffer.from("pixels");
      NodeFS.writeFileSync(
        NodePath.join(config.attachmentsDir, `pending-${attachmentUuid}.png`),
        bytes,
      );

      yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [{ id: `pending-${attachmentUuid}`, sizeBytes: bytes.byteLength }],
        }),
      );
      NodeFS.rmSync(NodePath.join(config.attachmentsDir, `thread-1-${attachmentUuid}.png`));

      const retried = yield* normalizeDispatchCommand(
        turnStartCommand({
          threadId: "thread-retry",
          attachments: [{ id: `pending-${attachmentUuid}`, sizeBytes: bytes.byteLength }],
        }),
      );
      if (retried.type !== "thread.turn.start") {
        throw new Error("Expected a thread.turn.start command.");
      }
      expect(retried.message.attachments[0]?.id).toBe(`thread-retry-${attachmentUuid}`);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects uploaded attachments with the wrong size or thread", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      NodeFS.writeFileSync(
        NodePath.join(config.attachmentsDir, `pending-${attachmentUuid}.png`),
        Buffer.from("pixels"),
      );

      const wrongSize = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [{ id: `pending-${attachmentUuid}`, sizeBytes: 999 }],
        }),
      ).pipe(Effect.flip);
      expect(wrongSize.message).toContain("size");

      const wrongThread = yield* normalizeDispatchCommand(
        turnStartCommand({
          attachments: [{ id: `another-thread-${attachmentUuid}`, sizeBytes: 6 }],
        }),
      ).pipe(Effect.flip);
      expect(wrongThread.message).toContain("another thread");

      const mismatchedTypeCommand = turnStartCommand({
        attachments: [{ id: `pending-${attachmentUuid}`, sizeBytes: 6 }],
      });
      if (mismatchedTypeCommand.type !== "thread.turn.start") {
        throw new Error("Expected a thread.turn.start command.");
      }
      const mismatchedType = yield* normalizeDispatchCommand({
        ...mismatchedTypeCommand,
        message: {
          ...mismatchedTypeCommand.message,
          attachments: mismatchedTypeCommand.message.attachments.map((attachment) => ({
            ...attachment,
            mimeType: "image/jpeg",
          })),
        },
      }).pipe(Effect.flip);
      expect(mismatchedType.message).toContain("image type");
    }).pipe(Effect.provide(testLayer)),
  );
});
