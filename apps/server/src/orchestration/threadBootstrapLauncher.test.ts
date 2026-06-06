import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { launchThreadBootstrap } from "./threadBootstrapLauncher.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-bootstrap-launcher");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const turnStartCommand: Extract<OrchestrationCommand, { type: "thread.turn.start" }> = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-turn-start"),
  threadId,
  message: {
    messageId: MessageId.make("msg-turn-start"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  createdAt: now,
};

describe("launchThreadBootstrap", () => {
  it("does not clean up a thread when thread creation itself fails", async () => {
    const dispatchedCommands: Array<OrchestrationCommand> = [];
    const closedThreads: Array<ThreadId> = [];
    const removedWorktrees: Array<string> = [];

    const result = await Effect.runPromiseExit(
      launchThreadBootstrap({
        threadId,
        orchestration: {
          dispatch: (command) =>
            Effect.sync(() => {
              dispatchedCommands.push(command);
              return command.type === "thread.create"
                ? Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: command.type,
                      detail: "create failed",
                    }),
                  )
                : Effect.succeed({ sequence: dispatchedCommands.length });
            }).pipe(Effect.flatten),
        },
        gitWorkflow: {
          removeWorktree: (input) =>
            Effect.sync(() => {
              removedWorktrees.push(input.path);
            }),
        },
        terminalManager: {
          close: (input) =>
            Effect.sync(() => {
              closedThreads.push(ThreadId.make(input.threadId));
            }),
        },
        setupScripts: {
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
        },
        nextCommandId: (tag) => Effect.succeed(CommandId.make(`cmd-${tag}`)),
        createThread: {
          threadId,
          projectId: ProjectId.make("project-bootstrap-launcher"),
          title: "Bootstrap",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        turnStart: turnStartCommand,
      }),
    );

    expect(result._tag).toBe("Failure");
    expect(dispatchedCommands.map((command) => command.type)).toEqual(["thread.create"]);
    expect(closedThreads).toEqual([]);
    expect(removedWorktrees).toEqual([]);
  });
});
