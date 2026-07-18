import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ThreadId,
  type ClientOrchestrationCommand,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const testLayer = Layer.mergeAll(
  ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-test-" }),
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

const now = "2026-01-01T00:00:00.000Z";

const turnStartCommand = (
  attachments: ReadonlyArray<UploadChatAttachment>,
): ClientOrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-turn-start-1"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("user-message-1"),
    role: "user",
    text: "hello normalizer",
    attachments,
  },
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  createdAt: now,
});

const asDataUrl = (mimeType: string, bytes: Buffer) =>
  `data:${mimeType};base64,${bytes.toString("base64")}`;

describe("Normalizer", () => {
  it.effect("persists file attachments and writes their bytes to the attachments dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const bytes = Buffer.from("hello world");

      const normalized = yield* normalizeDispatchCommand(
        turnStartCommand([
          {
            type: "file",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: bytes.byteLength,
            dataUrl: asDataUrl("text/plain", bytes),
          },
        ]),
      );

      expect(normalized.type).toBe("thread.turn.start");
      if (normalized.type !== "thread.turn.start") {
        return;
      }
      const attachment = normalized.message.attachments[0];
      expect(attachment).toMatchObject({
        type: "file",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: bytes.byteLength,
      });
      expect(attachment?.id).toMatch(
        /^thread-1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      if (!attachment) {
        return;
      }

      const attachmentPath = path.join(attachmentsDir, `${attachment.id}.txt`);
      expect(yield* fileSystem.readFileString(attachmentPath)).toBe("hello world");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects image attachments with a non-image data URL mime type", () =>
    Effect.gen(function* () {
      const error = yield* normalizeDispatchCommand(
        turnStartCommand([
          {
            type: "image",
            name: "fake.png",
            mimeType: "image/png",
            sizeBytes: 5,
            dataUrl: asDataUrl("text/plain", Buffer.from("hello")),
          },
        ]),
      ).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationDispatchCommandError");
      expect(error.message).toBe("Invalid image attachment payload for 'fake.png'.");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects file attachments over the maximum attachment size", () =>
    Effect.gen(function* () {
      const bytes = Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1, "a");
      const error = yield* normalizeDispatchCommand(
        turnStartCommand([
          {
            type: "file",
            name: "big.txt",
            mimeType: "text/plain",
            sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
            dataUrl: asDataUrl("text/plain", bytes),
          },
        ]),
      ).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationDispatchCommandError");
      expect(error.message).toBe("Attachment 'big.txt' is empty or too large.");
    }).pipe(Effect.provide(testLayer)),
  );
});
