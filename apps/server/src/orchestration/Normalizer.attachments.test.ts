import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
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
  ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-attachments-test-" }),
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

const turnStartCommand = (
  attachments: ReadonlyArray<UploadChatAttachment>,
): ClientOrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-turn-start-attachments"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("user-message-attachments"),
    role: "user",
    text: "read this file",
    attachments,
  },
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const asDataUrl = (mimeType: string, bytes: Buffer) =>
  `data:${mimeType};base64,${bytes.toString("base64")}`;

describe("Normalizer file attachments", () => {
  it.effect("persists arbitrary file bytes with a safe inferred extension", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const bytes = Buffer.from("spreadsheet-like data");
      const normalized = yield* normalizeDispatchCommand(
        turnStartCommand([
          {
            type: "file",
            name: "report.csv",
            mimeType: "text/csv",
            sizeBytes: bytes.byteLength,
            dataUrl: asDataUrl("text/csv", bytes),
          },
        ]),
      );

      expect(normalized.type).toBe("thread.turn.start");
      if (normalized.type !== "thread.turn.start") return;
      const attachment = normalized.message.attachments[0];
      expect(attachment).toMatchObject({ type: "file", name: "report.csv", mimeType: "text/csv" });
      if (!attachment) return;
      const attachmentPath = path.join(attachmentsDir, `${attachment.id}.csv`);
      expect(yield* fileSystem.readFileString(attachmentPath)).toBe(bytes.toString());
    }).pipe(Effect.provide(testLayer)),
  );
});
