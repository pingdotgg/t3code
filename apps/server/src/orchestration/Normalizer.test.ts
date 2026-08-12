import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";
const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-normalizer-test-",
});
const testLayer = Layer.mergeAll(configLayer, WorkspacePaths.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });

  it.effect("re-normalizes attachment replays without mutating accepted attachment bytes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const originalBytes = Buffer.from("original-image-bytes");
      const alteredBytes = Buffer.from("altered-image-bytes");
      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-attachment-replay"),
        threadId: ThreadId.make("thread-attachment-replay"),
        message: {
          messageId: MessageId.make("message-attachment-replay"),
          role: "user",
          text: "Inspect this image",
          attachments: [
            {
              type: "image",
              name: "proof.png",
              mimeType: "image/png",
              sizeBytes: originalBytes.byteLength,
              dataUrl: `data:image/png;base64,${originalBytes.toString("base64")}`,
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: clientCreatedAt,
      };

      const first = yield* normalizeDispatchCommand(command);
      const replay = yield* normalizeDispatchCommand(command);
      if (first.type !== "thread.turn.start" || replay.type !== "thread.turn.start") {
        throw new Error("Expected normalized turn starts");
      }
      const firstAttachment = first.message.attachments[0];
      const replayAttachment = replay.message.attachments[0];
      expect(replayAttachment).toEqual(firstAttachment);
      if (!firstAttachment) {
        throw new Error("Expected normalized attachment");
      }
      const originalPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: firstAttachment,
      });
      if (!originalPath) {
        throw new Error("Expected persisted attachment path");
      }
      expect(Buffer.from(yield* fileSystem.readFile(originalPath))).toEqual(originalBytes);

      const altered = yield* normalizeDispatchCommand({
        ...command,
        message: {
          ...command.message,
          attachments: [
            {
              ...command.message.attachments[0]!,
              sizeBytes: alteredBytes.byteLength,
              dataUrl: `data:image/png;base64,${alteredBytes.toString("base64")}`,
            },
          ],
        },
      });
      if (altered.type !== "thread.turn.start") {
        throw new Error("Expected normalized turn start");
      }
      expect(altered.message.attachments[0]?.id).not.toBe(firstAttachment.id);
      expect(Buffer.from(yield* fileSystem.readFile(originalPath))).toEqual(originalBytes);
    }).pipe(Effect.provide(testLayer)),
  );
});
