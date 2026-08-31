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
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

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
});

it.effect("seeds project.create from the user t3.json instead of client input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-normalizer-user-actions-",
      });
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-normalizer-project-",
      });
      yield* fileSystem.writeFileString(
        path.join(stateDir, "t3.json"),
        '{ "scripts": [{ "name": "Handoff", "command": "t3-handoff action" }] }',
      );

      const command: ClientOrchestrationCommand = {
        type: "project.create",
        commandId: CommandId.make("command-user-actions"),
        projectId: ProjectId.make("project-user-actions"),
        title: "User actions",
        workspaceRoot,
        scripts: [
          {
            id: "spoofed",
            name: "Spoofed",
            command: "false",
            icon: "play",
            runOnWorktreeCreate: false,
          },
        ],
        createdAt: clientCreatedAt,
      };

      const normalized = yield* normalizeDispatchCommand(command).pipe(
        Effect.provideService(ServerConfig.ServerConfig, { stateDir } as never),
        Effect.provideService(WorkspacePaths.WorkspacePaths, {
          normalizeWorkspaceRoot: (value) => Effect.succeed(value),
          resolveRelativePathWithinRoot: () => Effect.die("unused"),
        }),
      );

      expect(normalized.type).toBe("project.create");
      if (normalized.type !== "project.create") {
        throw new Error("Expected project.create");
      }
      expect(normalized.scripts).toEqual([
        {
          id: "handoff",
          name: "Handoff",
          command: "t3-handoff action",
          icon: "play",
          runOnWorktreeCreate: false,
        },
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
