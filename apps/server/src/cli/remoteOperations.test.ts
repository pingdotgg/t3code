import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentConflictError,
  EnvironmentScopeRequiredError,
  type AuthSessionState,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThreadDetailSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { RemoteEnvironmentAuthTimeoutError } from "@t3tools/client-runtime/authorization";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  dispatchRemoteCommandSafely,
  makeRemoteCreateCommand,
  makeRemoteSendCommand,
  remoteSessionHasScopes,
} from "./remoteOperations.ts";

const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex_personal"),
  model: "gpt-test",
};

const threadSnapshot = (input?: {
  readonly commandId?: CommandId;
}): OrchestrationThreadDetailSnapshot =>
  ({
    snapshotSequence: 12,
    thread: {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      branch: "feature/thread",
      worktreePath: "/repo/.worktrees/thread",
      latestTurn: null,
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
      archivedAt: null,
      deletedAt: null,
      messages:
        input?.commandId === undefined
          ? []
          : [
              {
                id: input.commandId,
                role: "user",
                text: "hello",
                turnId: null,
                streaming: false,
                createdAt: "2026-07-21T00:00:00.000Z",
                updatedAt: "2026-07-21T00:00:00.000Z",
              },
            ],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  }) as unknown as OrchestrationThreadDetailSnapshot;

describe("remote orchestration commands", () => {
  it("gates read and operate capabilities against authenticated session scopes", () => {
    const session = {
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["bearer-access-token"],
        sessionCookieName: "t3_session",
      },
      scopes: ["orchestration:read"],
      sessionMethod: "bearer-access-token",
    } as AuthSessionState;
    expect(remoteSessionHasScopes(session, ["orchestration:read"])).toBe(true);
    expect(remoteSessionHasScopes(session, ["orchestration:read", "orchestration:operate"])).toBe(
      false,
    );
    expect(remoteSessionHasScopes({ ...session, authenticated: false }, [])).toBe(false);
  });

  it("inherits persisted modes when sending to an existing thread", () => {
    const command = makeRemoteSendCommand({
      snapshot: threadSnapshot(),
      commandId: CommandId.make("command-send"),
      message: "continue",
      createdAt: "2026-07-21T00:01:00.000Z",
    });

    expect(command.runtimeMode).toBe("approval-required");
    expect(command.interactionMode).toBe("plan");
    expect(command.message.messageId).toBe(command.commandId);
    expect(command.bootstrap).toBeUndefined();
  });

  it("builds typed createThread + prepareWorktree bootstrap with safe defaults", () => {
    const project = {
      id: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/repo/project",
      defaultModelSelection: modelSelection,
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: "vp install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ],
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    } as unknown as OrchestrationProjectShell;

    const command = makeRemoteCreateCommand({
      project,
      modelSelection,
      threadId: ThreadId.make("thread-new"),
      commandId: CommandId.make("command-create"),
      message: "implement it",
      title: "Implement it",
      branch: "feat/remote-task",
      baseBranch: "main",
      createdAt: "2026-07-21T00:01:00.000Z",
    });

    expect(command.runtimeMode).toBe("full-access");
    expect(command.interactionMode).toBe("default");
    expect(command.bootstrap).toEqual({
      createThread: expect.objectContaining({
        projectId: "project-1",
        branch: null,
        worktreePath: null,
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
      prepareWorktree: {
        projectCwd: "/repo/project",
        baseBranch: "main",
        branch: "feat/remote-task",
      },
      runSetupScript: true,
    });
  });

  it.effect("re-reads an ambiguous write and does not retry when its command is visible", () =>
    Effect.gen(function* () {
      const commandId = CommandId.make("command-ambiguous");
      const command = makeRemoteSendCommand({
        snapshot: threadSnapshot(),
        commandId,
        message: "continue",
        createdAt: "2026-07-21T00:01:00.000Z",
      });
      let retries = 0;
      const result = yield* dispatchRemoteCommandSafely({
        command,
        dispatch: Effect.fail(
          new RemoteEnvironmentAuthTimeoutError(
            "https://remote.example/api/orchestration/dispatch",
            10_000,
          ),
        ),
        readThread: Effect.succeed(Option.some(threadSnapshot({ commandId }))),
        retryDispatch: Effect.sync(() => {
          retries += 1;
          return { sequence: 13 };
        }),
      });

      expect(result).toEqual({ sequence: 12, recovered: true });
      expect(retries).toBe(0);
    }),
  );

  it.effect("re-reads before retrying the same command id when the write is absent", () =>
    Effect.gen(function* () {
      const command = makeRemoteSendCommand({
        snapshot: threadSnapshot(),
        commandId: CommandId.make("command-retry"),
        message: "continue",
        createdAt: "2026-07-21T00:01:00.000Z",
      });
      const order: string[] = [];
      const result = yield* dispatchRemoteCommandSafely({
        command,
        dispatch: Effect.fail(
          new RemoteEnvironmentAuthTimeoutError(
            "https://remote.example/api/orchestration/dispatch",
            10_000,
          ),
        ),
        readThread: Effect.sync(() => {
          order.push("read");
          return Option.none();
        }),
        retryDispatch: Effect.sync(() => {
          order.push("retry");
          return { sequence: 14 };
        }),
      });

      expect(result).toEqual({ sequence: 14, recovered: false });
      expect(order).toEqual(["read", "retry"]);
    }),
  );

  it.effect("does not retry a definitive scope failure", () =>
    Effect.gen(function* () {
      const command = makeRemoteSendCommand({
        snapshot: threadSnapshot(),
        commandId: CommandId.make("command-denied"),
        message: "continue",
        createdAt: "2026-07-21T00:01:00.000Z",
      });
      let read = false;
      const error = yield* dispatchRemoteCommandSafely({
        command,
        dispatch: Effect.fail(
          new EnvironmentScopeRequiredError({
            code: "insufficient_scope",
            requiredScope: "orchestration:operate",
            traceId: "trace-1",
          }),
        ),
        readThread: Effect.sync(() => {
          read = true;
          return Option.none();
        }),
        retryDispatch: Effect.succeed({ sequence: 99 }),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(EnvironmentScopeRequiredError);
      expect(read).toBe(false);
    }),
  );

  it.effect("does not retry a definitive worktree conflict", () =>
    Effect.gen(function* () {
      const command = makeRemoteSendCommand({
        snapshot: threadSnapshot(),
        commandId: CommandId.make("command-conflict"),
        message: "continue",
        createdAt: "2026-07-21T00:01:00.000Z",
      });
      let read = false;
      let retried = false;
      const conflict = new EnvironmentConflictError({
        code: "conflict",
        reason: "worktree_branch_exists",
        message: "The requested branch already exists locally. Choose a different branch.",
        traceId: "0123456789abcdef0123456789abcdef",
      });
      const error = yield* dispatchRemoteCommandSafely({
        command,
        dispatch: Effect.fail(conflict),
        readThread: Effect.sync(() => {
          read = true;
          return Option.none();
        }),
        retryDispatch: Effect.sync(() => {
          retried = true;
          return { sequence: 99 };
        }),
      }).pipe(Effect.flip);

      expect(error).toBe(conflict);
      expect(read).toBe(false);
      expect(retried).toBe(false);
    }),
  );
});
