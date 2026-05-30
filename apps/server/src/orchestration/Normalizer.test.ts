import {
  CommandId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const TestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-normalizer-attachments-",
}).pipe(Layer.provideMerge(WorkspacePathsLive), Layer.provideMerge(NodeServices.layer));

let nextImageUploadCommandId = 0;

function imageUploadCommand(
  dataUrl: string,
  type: "thread.turn.start" | "thread.turn.queue" = "thread.turn.start",
): ClientOrchestrationCommand {
  const nextId = nextImageUploadCommandId++;
  return {
    type,
    commandId: CommandId.make(`cmd-${nextId}`),
    threadId: ThreadId.make("thread-normalizer"),
    message: {
      messageId: MessageId.make(`message-${nextId}`),
      role: "user",
      text: "see image",
      attachments: [
        {
          type: "image",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 4,
          dataUrl,
        },
      ],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

it.layer(TestLayer)("normalizeDispatchCommand image attachments", (it) => {
  it.effect("persists uploaded image data URLs and strips upload-only data", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig;
      const normalized = yield* normalizeDispatchCommand(
        imageUploadCommand("data:image/png;base64,iVBORw=="),
      );

      assert.equal(normalized.type, "thread.turn.start");
      if (normalized.type !== "thread.turn.start") {
        return;
      }
      const attachment = normalized.message.attachments[0];
      assert.deepInclude(attachment, {
        type: "image",
        name: "example.png",
        mimeType: "image/png",
        sizeBytes: 4,
      });
      assert.notProperty(attachment, "dataUrl");

      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment: attachment!,
      });
      assert.isString(attachmentPath);
      const fileInfo = yield* fileSystem.stat(attachmentPath!);
      assert.equal(fileInfo.type, "File");
      assert.equal(Number(fileInfo.size), 4);
    }),
  );

  it.effect("persists uploaded image data URLs for queued turns", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig;
      const normalized = yield* normalizeDispatchCommand(
        imageUploadCommand("data:image/png;base64,iVBORw==", "thread.turn.queue"),
      );

      assert.equal(normalized.type, "thread.turn.queue");
      if (normalized.type !== "thread.turn.queue") {
        return;
      }
      const attachment = normalized.message.attachments[0];
      assert.notProperty(attachment, "dataUrl");

      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment: attachment!,
      });
      assert.isString(attachmentPath);
      const fileInfo = yield* fileSystem.stat(attachmentPath!);
      assert.equal(fileInfo.type, "File");
      assert.equal(Number(fileInfo.size), 4);
    }),
  );

  it.effect("rejects invalid, malformed, empty, and oversized uploads", () =>
    Effect.gen(function* () {
      const oversizedBytes = new Uint8Array(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
      oversizedBytes.fill(1);
      const oversizedDataUrl = `data:image/png;base64,${Buffer.from(oversizedBytes).toString("base64")}`;

      const cases = [
        "data:text/plain;base64,SGVsbG8=",
        "not-a-data-url",
        "data:image/png;base64,",
        oversizedDataUrl,
      ];

      for (const dataUrl of cases) {
        const exit = yield* Effect.exit(normalizeDispatchCommand(imageUploadCommand(dataUrl)));
        assert.isTrue(exit._tag === "Failure");
      }
    }),
  );
});
