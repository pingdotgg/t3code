import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
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

import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBootstrap } from "../../../orchestration/Services/ThreadBootstrap.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { defaultThreadTitle, ThreadsToolkitHandlersLive } from "./handlers.ts";
import { ThreadsToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claude");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(0xab),
  digest: (_algorithm, data) => {
    const out = new Uint8Array(32);
    for (let index = 0; index < data.length; index += 1) {
      out[index % 32] = (out[index % 32]! + data[index]!) & 0xff;
    }
    return Effect.succeed(out);
  },
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: CODEX,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeProject(): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "API review",
    modelSelection: { instanceId: CODEX, model: "gpt-5" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    branch: "feature/api",
    worktreePath: "/workspace/project/.worktrees/api",
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

type TurnStart = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

interface HarnessOptions {
  readonly thread?: OrchestrationThreadShell | null;
  readonly project?: OrchestrationProjectShell | null;
  readonly existing?: ReadonlyMap<string, OrchestrationThreadShell>;
  readonly failDispatch?: boolean;
  readonly appearsAfterFailedDispatch?: OrchestrationThreadShell;
}

const makeHarness = Effect.fn("makeThreadsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<TurnStart>>([]);
  const thread = options.thread === undefined ? makeThread() : options.thread;
  const project = options.project === undefined ? makeProject() : options.project;
  const existing = new Map(options.existing ?? []);
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(
          threadId === THREAD_ID
            ? Option.fromNullishOr(thread)
            : Option.fromNullishOr(existing.get(threadId)),
        ),
      getProjectShellById: () => Effect.succeed(Option.fromNullishOr(project)),
    }),
    Layer.mock(ThreadBootstrap)({
      dispatchTurnStart: (command) => {
        const raced = options.appearsAfterFailedDispatch;
        if (raced) {
          existing.set(raced.id, raced);
          return Effect.fail(
            new OrchestrationDispatchCommandError({ message: "Thread already exists." }),
          );
        }
        return options.failDispatch
          ? Effect.fail(new OrchestrationDispatchCommandError({ message: "worktree exists" }))
          : Ref.update(commands, (recorded) => [...recorded, command]).pipe(
              Effect.as({ sequence: 1 }),
            );
      },
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* ThreadsToolkit.pipe(
    Effect.provide(ThreadsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = (
    params: Parameters<typeof toolkit.handle<"t3_thread_start">>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["threads"],
  ) =>
    toolkit.handle("t3_thread_start", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) =>
          chunk.at(-1)!.result as Tool.Success<(typeof ThreadsToolkit.tools)["t3_thread_start"]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  const dispatched = Ref.get(commands);
  return { call, dispatched };
});

const PROMPT = "Finish the pagination fix\n\nThe cursor is in src/api/list.ts.";

describe("threads toolkit handlers", () => {
  it.effect("refuses a credential without the threads capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call({ prompt: PROMPT }, ["preview"]).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "threads",
        threadId: THREAD_ID,
      });
      expect(yield* harness.dispatched).toEqual([]);
    }),
  );

  it.effect("creates and starts a sibling thread that inherits the caller's settings", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call({ prompt: PROMPT });
      const [command] = yield* harness.dispatched;

      expect(result).toEqual({
        threadId: "abababab-abab-4bab-abab-abababababab",
        title: "Finish the pagination fix",
        modelSelection: { instanceId: CODEX, model: "gpt-5" },
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        branch: "feature/api",
        worktreePath: "/workspace/project/.worktrees/api",
        alreadyStarted: false,
      });
      expect(command?.message.text).toBe(
        `> Handed off from T3 thread "API review" (thread-1).\n\n${PROMPT}`,
      );
      expect(command?.titleSeed).toBe("Finish the pagination fix");
      expect(command?.bootstrap).toEqual({
        createThread: {
          projectId: PROJECT_ID,
          title: "Finish the pagination fix",
          modelSelection: { instanceId: CODEX, model: "gpt-5" },
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          branch: "feature/api",
          worktreePath: "/workspace/project/.worktrees/api",
          createdAt: command?.createdAt,
        },
      });
      expect(command?.threadId).toBe("abababab-abab-4bab-abab-abababababab");
      expect(command?.commandId).toMatch(/^server:mcp-thread-start:thread-1:/);
    }),
  );

  it.effect("uses an explicit title and skips the title seed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call({ prompt: PROMPT, title: "Pagination" });
      const [command] = yield* harness.dispatched;
      expect(result.title).toBe("Pagination");
      expect(command?.bootstrap?.createThread?.title).toBe("Pagination");
      expect(command?.titleSeed).toBeUndefined();
    }),
  );

  it.effect("applies model and interaction overrides but keeps the caller's permission mode", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call({
        prompt: PROMPT,
        modelSelection: { instanceId: CLAUDE, model: "claude-opus-5" },
        interactionMode: "plan",
      });
      const [command] = yield* harness.dispatched;
      expect(result.modelSelection).toEqual({ instanceId: CLAUDE, model: "claude-opus-5" });
      expect(result.interactionMode).toBe("plan");
      expect(result.runtimeMode).toBe("auto-accept-edits");
      expect(command?.modelSelection).toEqual({ instanceId: CLAUDE, model: "claude-opus-5" });
      expect(command?.interactionMode).toBe("plan");
      expect(command?.runtimeMode).toBe("auto-accept-edits");
      expect(command?.bootstrap?.createThread?.modelSelection).toEqual({
        instanceId: CLAUDE,
        model: "claude-opus-5",
      });
    }),
  );

  it.effect("prepares a fresh worktree from the caller's branch when asked", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call({ prompt: PROMPT, worktree: {} });
      const [command] = yield* harness.dispatched;
      expect(command?.bootstrap).toEqual({
        createThread: expect.objectContaining({ branch: null, worktreePath: null }),
        prepareWorktree: {
          projectCwd: "/workspace/project",
          baseBranch: "feature/api",
          branch: "t3code/abababab",
        },
        runSetupScript: true,
      });
    }),
  );

  it.effect("passes explicit worktree options through", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call({
        prompt: PROMPT,
        worktree: { baseBranch: "main", branch: "feat/pagination", startFromOrigin: true },
      });
      const [command] = yield* harness.dispatched;
      expect(command?.bootstrap?.prepareWorktree).toEqual({
        projectCwd: "/workspace/project",
        baseBranch: "main",
        branch: "feat/pagination",
        startFromOrigin: true,
      });
    }),
  );

  it.effect("requires a base branch for a worktree when the caller has none", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ thread: makeThread({ branch: null }) });
      const error = yield* harness.call({ prompt: PROMPT, worktree: {} }).pipe(Effect.flip);
      expect(error._tag).toBe("ThreadStartWorktreeBaseRequiredError");
      expect(yield* harness.dispatched).toEqual([]);
    }),
  );

  it.effect("derives the thread and command ids from clientRequestId", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness();
      const second = yield* makeHarness();
      const a = yield* first.call({ prompt: PROMPT, clientRequestId: "req-1" });
      const b = yield* second.call({ prompt: PROMPT, clientRequestId: "req-1" });
      expect(a.threadId).toBe(b.threadId);
      expect(a.threadId).not.toBe("abababab-abab-4bab-abab-abababababab");
      const [commandA] = yield* first.dispatched;
      const [commandB] = yield* second.dispatched;
      expect(commandA?.commandId).toBe("server:mcp-thread-start:thread-1:req-1");
      expect(commandB?.commandId).toBe("server:mcp-thread-start:thread-1:req-1");
    }),
  );

  it.effect("returns the existing thread for a repeated clientRequestId", () =>
    Effect.gen(function* () {
      const probe = yield* makeHarness();
      const created = yield* probe.call({ prompt: PROMPT, clientRequestId: "req-1" });
      const existingThread = makeThread({
        id: ThreadId.make(created.threadId),
        title: "Finish the pagination fix",
      });
      const harness = yield* makeHarness({
        existing: new Map([[created.threadId, existingThread]]),
      });
      const result = yield* harness.call({ prompt: PROMPT, clientRequestId: "req-1" });
      expect(result).toEqual({
        threadId: created.threadId,
        title: "Finish the pagination fix",
        modelSelection: { instanceId: CODEX, model: "gpt-5" },
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        branch: "feature/api",
        worktreePath: "/workspace/project/.worktrees/api",
        alreadyStarted: true,
      });
      expect(yield* harness.dispatched).toEqual([]);
    }),
  );

  it.effect("returns the thread a concurrent call created under the same clientRequestId", () =>
    Effect.gen(function* () {
      const probe = yield* makeHarness();
      const created = yield* probe.call({ prompt: PROMPT, clientRequestId: "req-1" });
      const raced = makeThread({ id: ThreadId.make(created.threadId), title: "Raced" });
      const harness = yield* makeHarness({ appearsAfterFailedDispatch: raced });
      const result = yield* harness.call({ prompt: PROMPT, clientRequestId: "req-1" });
      expect(result.threadId).toBe(created.threadId);
      expect(result.title).toBe("Raced");
      expect(result.alreadyStarted).toBe(true);

      const noKey = yield* makeHarness({ appearsAfterFailedDispatch: raced });
      const error = yield* noKey.call({ prompt: PROMPT }).pipe(Effect.flip);
      expect(error._tag).toBe("ThreadStartFailedError");
    }),
  );

  it.effect("rejects an archived caller and a missing project", () =>
    Effect.gen(function* () {
      const archived = yield* makeHarness({
        thread: makeThread({ archivedAt: "2026-08-21T00:00:00.000Z" }),
      });
      const archivedError = yield* archived.call({ prompt: PROMPT }).pipe(Effect.flip);
      expect(archivedError).toMatchObject({
        _tag: "ThreadStartCallerArchivedError",
        threadId: THREAD_ID,
      });

      const orphan = yield* makeHarness({ project: null });
      const orphanError = yield* orphan.call({ prompt: PROMPT }).pipe(Effect.flip);
      expect(orphanError).toMatchObject({
        _tag: "ThreadStartProjectNotFoundError",
        projectId: PROJECT_ID,
      });
    }),
  );

  it.effect("surfaces a bootstrap failure as ThreadStartFailedError", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ failDispatch: true });
      const error = yield* harness.call({ prompt: PROMPT }).pipe(Effect.flip);
      expect(error._tag).toBe("ThreadStartFailedError");
    }),
  );
});

describe("defaultThreadTitle", () => {
  it("takes the first non-empty line", () => {
    expect(defaultThreadTitle("\n\n  Ship it  \nmore")).toBe("Ship it");
  });

  it("truncates long lines with an ellipsis", () => {
    const long = "x".repeat(100);
    expect(defaultThreadTitle(long)).toBe(`${"x".repeat(79)}…`);
    expect(defaultThreadTitle(long)).toHaveLength(80);
  });
});
