import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";
import * as NodeCrypto from "node:crypto";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadsToolkitHandlersLive } from "./handlers.ts";
import { ThreadsToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const OTHER_THREAD_ID = ThreadId.make("thread-2");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) =>
    Effect.succeed(new Uint8Array(NodeCrypto.createHash("sha256").update(data).digest())),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  threadId: ThreadId = THREAD_ID,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Parent thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/work",
    worktreePath: "/workspace/project-feature",
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

interface HarnessOptions {
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly reject?: (command: OrchestrationCommand) => OrchestrationCommandInvariantError | null;
}

const makeHarness = Effect.fn("makeThreadsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const threads = options.threads ?? [makeThread(), makeThread({ id: OTHER_THREAD_ID })];
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null) return yield* rejection;
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1 };
    });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(Option.fromNullishOr(threads.find((thread) => thread.id === threadId))),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* ThreadsToolkit.pipe(
    Effect.provide(ThreadsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = (
    params: Parameters<typeof toolkit.handle<"start_thread">>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["threads"],
    caller: ThreadId = THREAD_ID,
  ) =>
    toolkit.handle("start_thread", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<typeof ThreadsToolkit.tools.start_thread>,
      ),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(capabilities, caller),
      ),
      Effect.provide(dependencies),
    );
  return { commands, call };
});

describe("threads toolkit handlers", () => {
  it.effect("refuses a credential without the threads capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call({ prompt: "Do the thing" }, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "threads",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("creates a thread in the caller's checkout and starts its first turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call({ prompt: "Fix the flaky test in auth" });
      expect(result).toEqual({ threadId: expect.any(String), title: "New thread" });
      expect(result.threadId).not.toBe(THREAD_ID);
      const commands = yield* Ref.get(harness.commands);
      expect(commands).toMatchObject([
        {
          type: "thread.create",
          threadId: result.threadId,
          projectId: PROJECT_ID,
          title: "New thread",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/work",
          worktreePath: "/workspace/project-feature",
        },
        {
          type: "thread.turn.start",
          threadId: result.threadId,
          message: { role: "user", text: "Fix the flaky test in auth", attachments: [] },
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      ]);
      // No titleSeed, so the reactor generates a title from the prompt.
      expect(commands[1]).not.toHaveProperty("titleSeed");
    }),
  );

  it.effect("applies model and mode overrides but keeps the caller's provider", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call({
        prompt: "Write the plan",
        title: "Auth plan",
        model: "gpt-5-mini",
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      expect(result.title).toBe("Auth plan");
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.create",
          title: "Auth plan",
          modelSelection: { instanceId: "codex", model: "gpt-5-mini" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
        {
          type: "thread.turn.start",
          titleSeed: "Auth plan",
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      ]);
    }),
  );

  it.effect("derives the thread and command ids from clientRequestId so a retry replays", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const first = yield* harness.call({ prompt: "Do it", clientRequestId: "req-1" });
      const retry = yield* harness.call({ prompt: "Do it", clientRequestId: "req-1" });
      expect(first.threadId).toMatch(/^mcp-[0-9a-f]{32}$/);
      expect(retry.threadId).toBe(first.threadId);

      // Same command ids on both calls: the real engine replays the accepted
      // receipt instead of creating or starting the thread twice.
      const commands = yield* Ref.get(harness.commands);
      expect(commands.map((command) => command.commandId)).toEqual([
        `server:mcp-thread-create:${first.threadId}`,
        `server:mcp-thread-turn-start:${first.threadId}`,
        `server:mcp-thread-create:${first.threadId}`,
        `server:mcp-thread-turn-start:${first.threadId}`,
      ]);

      // A different request id, the same id from another caller, and a call
      // without an id each get their own thread.
      const other = yield* harness.call({ prompt: "Do it", clientRequestId: "req-2" });
      const otherCaller = yield* harness.call(
        { prompt: "Do it", clientRequestId: "req-1" },
        ["threads"],
        OTHER_THREAD_ID,
      );
      const anonymous = yield* harness.call({ prompt: "Do it" });
      expect(other.threadId).not.toBe(first.threadId);
      expect(otherCaller.threadId).not.toBe(first.threadId);
      expect(anonymous.threadId).not.toMatch(/^mcp-/);
    }),
  );

  it.effect("surfaces a rejected create as a tool failure", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        reject: (command) =>
          command.type === "thread.create"
            ? new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Project does not exist.",
              })
            : null,
      });
      const error = yield* harness.call({ prompt: "Do it" }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "StartThreadFailedError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("fails when the calling thread no longer exists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ threads: [] });
      const error = yield* harness.call({ prompt: "Do it" }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "StartThreadCallerNotFoundError",
        threadId: THREAD_ID,
      });
    }),
  );
});
