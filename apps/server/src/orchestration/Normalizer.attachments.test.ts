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

const UUID = "00000000-0000-4000-8000-0000000000aa";

function turnStartCommand(attachment: {
  readonly id: string;
  readonly sizeBytes: number;
}): ClientOrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("command-1"),
    threadId: ThreadId.make("thread-1"),
    message: {
      messageId: MessageId.make("message-1"),
      role: "user",
      text: "look at this",
      attachments: [
        {
          type: "image",
          id: attachment.id,
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: attachment.sizeBytes,
        },
      ],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("normalizeDispatchCommand attachments", () => {
  it.effect("claims a pending upload: renames the file and rewrites the id", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const bytes = Buffer.from("pixels");
      const pendingPath = NodePath.join(config.attachmentsDir, `pending-${UUID}.png`);
      NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
      NodeFS.writeFileSync(pendingPath, bytes);

      const normalized = yield* normalizeDispatchCommand(
        turnStartCommand({ id: `pending-${UUID}`, sizeBytes: bytes.byteLength }),
      );
      if (normalized.type !== "thread.turn.start") {
        throw new Error("Expected a thread.turn.start command");
      }
      expect(normalized.message.attachments).toHaveLength(1);
      expect(normalized.message.attachments[0]?.id).toBe(`thread-1-${UUID}`);
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(config.attachmentsDir, `thread-1-${UUID}.png`))).toBe(
        true,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("is idempotent when a retry references an already-claimed file", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const bytes = Buffer.from("pixels");
      NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `thread-1-${UUID}.png`), bytes);

      // The retry still carries the original pending id.
      const normalized = yield* normalizeDispatchCommand(
        turnStartCommand({ id: `pending-${UUID}`, sizeBytes: bytes.byteLength }),
      );
      if (normalized.type !== "thread.turn.start") {
        throw new Error("Expected a thread.turn.start command");
      }
      expect(normalized.message.attachments[0]?.id).toBe(`thread-1-${UUID}`);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails when the referenced upload does not exist", () =>
    Effect.gen(function* () {
      const error = yield* normalizeDispatchCommand(
        turnStartCommand({ id: `pending-${UUID}`, sizeBytes: 6 }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationDispatchCommandError");
      expect(error.message).toContain("not found");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("fails when the stored size does not match the reference", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(config.attachmentsDir, `pending-${UUID}.png`),
        Buffer.from("pixels"),
      );

      const error = yield* normalizeDispatchCommand(
        turnStartCommand({ id: `pending-${UUID}`, sizeBytes: 999 }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationDispatchCommandError");
      expect(error.message).toContain("size");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses an attachment already claimed by another thread", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const bytes = Buffer.from("pixels");
      NodeFS.mkdirSync(config.attachmentsDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `other-thread-${UUID}.png`), bytes);

      const error = yield* normalizeDispatchCommand(
        turnStartCommand({ id: `pending-${UUID}`, sizeBytes: bytes.byteLength }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationDispatchCommandError");
      expect(error.message).toContain("another thread");
    }).pipe(Effect.provide(testLayer)),
  );
});
