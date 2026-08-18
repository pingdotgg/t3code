import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { attachmentRelativePath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

const normalizeTestLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-attachment-" }),
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

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

  it.effect("persists PDF turn attachments with PDF metadata and extension", () =>
    Effect.gen(function* () {
      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("normalizer-pdf-command"),
        threadId: ThreadId.make("normalizer-pdf-thread"),
        message: {
          messageId: MessageId.make("normalizer-pdf-message"),
          role: "user",
          text: "Read this document",
          attachments: [
            {
              type: "pdf",
              name: "spec.pdf",
              mimeType: "application/pdf",
              sizeBytes: 6,
              dataUrl: "data:application/pdf;base64,JVBERi0x",
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: clientCreatedAt,
      };

      const result = yield* normalizeDispatchCommand(command);
      expect(result.type).toBe("thread.turn.start");
      if (result.type !== "thread.turn.start") {
        return;
      }

      const attachment = result.message.attachments[0];
      if (!attachment) {
        throw new Error("Expected a persisted PDF attachment");
      }
      expect(attachment).toMatchObject({
        type: "pdf",
        name: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: 6,
      });
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const info = yield* fileSystem.stat(
        path.join(config.attachmentsDir, attachmentRelativePath(attachment)),
      );
      expect(info.type).toBe("File");
    }).pipe(Effect.provide(normalizeTestLayer)),
  );
});
