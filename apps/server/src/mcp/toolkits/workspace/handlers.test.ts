import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import { WorkspaceMcpAuth, type WorkspaceMcpPrincipal } from "./principal.ts";
import { WorkspaceMcpError } from "./errors.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationThreadSettleBlockedError,
  type OrchestrationDispatchError,
} from "../../../orchestration/Errors.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type OrchestrationCommand,
} from "@t3tools/contracts";

import { buildCreateProjectCommand, buildStartThreadCommand, handlers } from "./handlers.ts";
import { titleFromPrompt } from "./mapping.ts";

describe("workspace MCP commands", () => {
  it("creates a project at an environment filesystem path", () => {
    const command = buildCreateProjectCommand({
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "t3code",
      workspaceRoot: "/Users/jjeaton/Documents/projects/t3code",
      createWorkspaceRootIfMissing: true,
      createdAt: "2026-08-28T12:00:00.000Z",
    });
    expect(command).toMatchObject({
      type: "project.create",
      title: "t3code",
      workspaceRoot: "/Users/jjeaton/Documents/projects/t3code",
    });
  });

  it("bootstraps a thread and first turn in one command", () => {
    const command = buildStartThreadCommand({
      commandId: CommandId.make("command-1"),
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("message-1"),
      projectId: ProjectId.make("project-1"),
      title: titleFromPrompt("Add dark mode to settings"),
      prompt: "Add dark mode to settings",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdAt: "2026-08-28T12:00:00.000Z",
    });
    expect(command.type).toBe("thread.turn.start");
    if (command.type === "thread.turn.start") {
      expect(command.message.text).toBe("Add dark mode to settings");
      expect(command.bootstrap?.createThread?.title).toBe("Add dark mode to settings");
      expect(command.modelSelection?.instanceId).toBe("codex");
    }
  });
});

function shell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Dark mode",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "completed",
      requestedAt: "2026-08-28T11:00:00.000Z",
      startedAt: "2026-08-28T11:00:00.000Z",
      completedAt: "2026-08-28T11:05:00.000Z",
      assistantMessageId: null,
    },
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T11:05:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId: ThreadId.make("thread-1"),
      status: "ready",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-08-28T11:05:00.000Z",
    },
    latestUserMessageAt: "2026-08-28T11:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    planProgress: null,
    ...overrides,
  };
}

const settledAt = "2026-08-28T12:00:00.000Z";

function harness(
  initial: OrchestrationThreadShell | null = shell(),
  rejection?: OrchestrationDispatchError,
) {
  let current = initial;
  const commands: OrchestrationCommand[] = [];
  const query = {
    getThreadShellById: () => Effect.succeed(Option.fromNullishOr(current)),
    getShellSnapshot: () => Effect.succeed({ threads: current ? [current] : [], projects: [] }),
    getThreadDetailSnapshot: () =>
      Effect.succeed(
        current
          ? Option.some({ thread: { ...current, messages: [], activities: [], proposedPlans: [] } })
          : Option.none(),
      ),
  };
  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        if (rejection) return yield* rejection;
        commands.push(command);
        if (current && command.type === "thread.settle") {
          current = {
            ...current,
            settledOverride: "settled",
            settledAt: current.settledAt ?? settledAt,
          };
        } else if (current && command.type === "thread.unsettle") {
          current = { ...current, settledOverride: "active", settledAt: null };
        }
        return { sequence: commands.length };
      }),
  };
  return {
    commands,
    current: () => current,
    run: (
      effect: Effect.Effect<
        unknown,
        WorkspaceMcpError,
        WorkspaceMcpAuth | ProjectionSnapshotQuery | OrchestrationEngineService | Crypto.Crypto
      >,
      principal: WorkspaceMcpPrincipal = { kind: "loopback" },
    ) =>
      effect.pipe(
        Effect.provideService(WorkspaceMcpAuth, principal),
        Effect.provideService(
          ProjectionSnapshotQuery,
          query as unknown as ProjectionSnapshotQuery["Service"],
        ),
        Effect.provideService(
          OrchestrationEngineService,
          engine as OrchestrationEngineService["Service"],
        ),
        Effect.provideService(
          Crypto.Crypto,
          Crypto.make({
            randomBytes: (size) => new Uint8Array(size),
            digest: (_algorithm, data) => Effect.succeed(data),
          }),
        ),
        Effect.result,
      ),
  };
}

describe("workspace settlement handlers", () => {
  const input = { threadId: ThreadId.make("thread-1") };
  it.effect("settles an idle completed thread and returns the projected brief", () =>
    Effect.gen(function* () {
      const h = harness();
      const result = yield* h.run(handlers.settle_thread(input));
      expect(result).toMatchObject({
        _tag: "Success",
        success: {
          ...input,
          shelf: "settled",
          status: "completed",
          settledAt,
          alreadySettled: false,
        },
      });
      expect(h.commands.map((command) => command.type)).toEqual(["thread.settle"]);
    }),
  );
  it.effect("list and detail agree after settle and unsettle", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run(handlers.settle_thread(input));
      expect(yield* h.run(handlers.list_threads({}))).toMatchObject({
        _tag: "Success",
        success: { threads: [{ shelf: "settled", status: "completed" }] },
      });
      expect(yield* h.run(handlers.get_thread(input))).toMatchObject({
        _tag: "Success",
        success: { shelf: "settled", status: "completed" },
      });
      yield* h.run(handlers.unsettle_thread(input));
      expect(yield* h.run(handlers.list_threads({}))).toMatchObject({
        _tag: "Success",
        success: { threads: [{ shelf: "active" }] },
      });
      expect(yield* h.run(handlers.get_thread(input))).toMatchObject({
        _tag: "Success",
        success: { shelf: "active" },
      });
    }),
  );
  it.effect("repeats settlement with the original timestamp", () =>
    Effect.gen(function* () {
      const h = harness(shell({ settledOverride: "settled", settledAt }));
      expect(yield* h.run(handlers.settle_thread(input))).toMatchObject({
        _tag: "Success",
        success: { settledAt, alreadySettled: true },
      });
    }),
  );
  it.effect.each(["running", "starting"] as const)(
    "rejects a %s session without dispatch",
    (status) =>
      Effect.gen(function* () {
        const initial = shell({ session: { ...shell().session!, status } });
        const h = harness(initial);
        expect(yield* h.run(handlers.settle_thread(input))).toMatchObject({
          _tag: "Failure",
          failure: { code: "conflict", detail: expect.stringContaining("turn must finish") },
        });
        expect(h.commands).toEqual([]);
        expect(h.current()).toBe(initial);
      }),
  );
  it.effect.each(["hasPendingApprovals", "hasPendingUserInput"] as const)("rejects %s", (flag) =>
    Effect.gen(function* () {
      const h = harness(shell({ [flag]: true }));
      expect(yield* h.run(handlers.settle_thread(input))).toMatchObject({
        _tag: "Failure",
        failure: { code: "conflict", detail: expect.stringContaining("pending") },
      });
      expect(h.commands).toEqual([]);
    }),
  );
  it.effect("rejects a queued start within the adoption window", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(settledAt));
      const h = harness(shell({ latestUserMessageAt: settledAt }));
      expect(yield* h.run(handlers.settle_thread(input))).toMatchObject({
        _tag: "Failure",
        failure: { code: "conflict", detail: expect.stringContaining("queued turn start") },
      });
      expect(h.commands).toEqual([]);
    }),
  );
  it.effect("does not block a stale unadopted start", () =>
    Effect.gen(function* () {
      const h = harness(shell({ latestUserMessageAt: "2026-08-28T12:00:00.000Z" }));
      expect(yield* h.run(handlers.settle_thread(input))).toMatchObject({ _tag: "Success" });
    }),
  );
  it.effect("rejects archived threads", () =>
    Effect.gen(function* () {
      const h = harness(shell({ archivedAt: settledAt }));
      expect(yield* h.run(handlers.settle_thread(input))).toMatchObject({
        _tag: "Failure",
        failure: { code: "conflict", detail: expect.stringContaining("archived") },
      });
      expect(h.commands).toEqual([]);
    }),
  );
  it.effect.each([null, "settled"] as const)(
    "unsettles %s without starting a turn",
    (settledOverride) =>
      Effect.gen(function* () {
        const h = harness(
          shell({ settledOverride, settledAt: settledOverride ? settledAt : null }),
        );
        expect(yield* h.run(handlers.unsettle_thread(input))).toMatchObject({
          _tag: "Success",
          success: { ...input, shelf: "active", status: "completed", unsettled: true },
        });
        expect(h.commands).toEqual([
          { type: "thread.unsettle", ...input, reason: "user", commandId: expect.any(String) },
        ]);
      }),
  );
  it.effect.each(["settle_thread", "unsettle_thread"] as const)(
    "%s requires a thread and operate scope",
    (name) =>
      Effect.gen(function* () {
        const missing = harness(null);
        expect(yield* missing.run(handlers[name](input))).toMatchObject({
          _tag: "Failure",
          failure: { code: "not_found" },
        });
        const readonly = harness();
        expect(
          yield* readonly.run(handlers[name](input), {
            kind: "session",
            scopes: new Set(["orchestration:read"]),
          }),
        ).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } });
        expect(missing.commands).toEqual([]);
        expect(readonly.commands).toEqual([]);
      }),
  );
  it.effect.each([
    new OrchestrationCommandInvariantError({
      commandType: "thread.settle",
      detail: "active session",
    }),
    new OrchestrationThreadSettleBlockedError({ threadId: input.threadId }),
  ])("maps raced dispatch rejection to conflict", (error) =>
    Effect.gen(function* () {
      const h = harness(shell(), error);
      expect(yield* h.run(handlers.settle_thread(input))).toMatchObject({
        _tag: "Failure",
        failure: {
          code: "conflict",
          detail: expect.stringContaining("History and artifacts were not changed"),
        },
      });
    }),
  );
});
