import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ServerProvider,
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

import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../../../orchestration/Errors.ts";
import { PersistenceSqlError } from "../../../persistence/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorToolkitHandlersLive } from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claude");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) =>
    Effect.succeed(new Uint8Array(NodeCrypto.createHash("sha256").update(data).digest())),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  providerSessionId = "provider-session-1",
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId,
  providerInstanceId: CODEX,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Parent thread",
    modelSelection: { instanceId: CODEX, model: "gpt-5" },
    runtimeMode: "auto",
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

function makeProvider(
  instanceId: ProviderInstanceId,
  driver: string,
  models: ReadonlyArray<string>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-01T00:00:00.000Z",
    models: models.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    })),
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

interface HarnessOptions {
  readonly parent?: OrchestrationThreadShell | null;
  readonly providers?: ReadonlyArray<ServerProvider>;
  /** A decider rejection. The engine stores a rejected receipt for it. */
  readonly reject?: (command: OrchestrationCommand) => OrchestrationCommandInvariantError | null;
  /** A storage failure. The engine stores no receipt, so a retry runs again. */
  readonly failTransiently?: (command: OrchestrationCommand) => boolean;
}

/**
 * Stands in for the engine: keeps a receipt per command id the way
 * OrchestrationEngine does, records applied commands, and projects
 * thread.create into the snapshot the handler reads back.
 */
const makeHarness = Effect.fn("makeOrchestratorToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const receipts = new Map<string, { readonly rejected: string | null }>();
  const parent = options.parent === undefined ? makeThread() : options.parent;
  const threads = new Map<ThreadId, OrchestrationThreadShell>(
    parent === null ? [] : [[parent.id, parent]],
  );
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const receipt = receipts.get(command.commandId);
      if (receipt?.rejected === null) return { sequence: 1 };
      if (receipt !== undefined) {
        return yield* new OrchestrationCommandPreviouslyRejectedError({
          commandId: command.commandId,
          detail: receipt.rejected,
        });
      }
      if (options.failTransiently?.(command) === true) {
        return yield* new PersistenceSqlError({ operation: "test.dispatch" });
      }
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null) {
        receipts.set(command.commandId, { rejected: rejection.detail });
        return yield* rejection;
      }
      receipts.set(command.commandId, { rejected: null });
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      if (command.type === "thread.create") {
        threads.set(
          command.threadId,
          makeThread({
            id: command.threadId,
            title: command.title,
            modelSelection: command.modelSelection,
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
          }),
        );
      }
      return { sequence: 1 };
    });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) => Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(
        options.providers ?? [
          makeProvider(CODEX, "codex", ["gpt-5", "gpt-5-mini"]),
          makeProvider(CLAUDE, "claudeAgent", ["claude-opus"]),
        ],
      ),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* OrchestratorToolkit.pipe(
    Effect.provide(OrchestratorToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const run = <Name extends keyof typeof OrchestratorToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    scope = invocation(["orchestration"]),
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(dependencies),
    );
  // failureMode is "return": a declared failure arrives as the result.
  const createThreads = (
    params: Parameters<typeof toolkit.handle<"create_threads">>[1],
    scope?: McpInvocationContext.McpInvocationScope,
  ) =>
    run("create_threads", params, scope).pipe(
      Effect.map(
        (part) => part.result as Tool.Success<typeof OrchestratorToolkit.tools.create_threads>,
      ),
    );
  const createThreadsFailure = (params: Parameters<typeof toolkit.handle<"create_threads">>[1]) =>
    run("create_threads", params).pipe(
      Effect.map((part) => {
        expect(part.isFailure).toBe(true);
        return part.result as Tool.Failure<typeof OrchestratorToolkit.tools.create_threads>;
      }),
    );
  return { commands, run, createThreads, createThreadsFailure };
});

describe("orchestrator toolkit: create_threads", () => {
  it.effect("refuses a credential without the orchestration capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const part = yield* harness.run(
        "create_threads",
        { threads: [{ prompt: "Do it" }] },
        invocation(["pull-requests"]),
      );
      expect(part.isFailure).toBe(true);
      expect(part.result).toMatchObject({ code: "capability_denied" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("creates threads in the caller's checkout and starts the ones with a prompt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.createThreads({
        threads: [{ prompt: "Fix the flaky auth test" }, { title: "Scratch" }],
      });
      expect(result.threads).toMatchObject([
        {
          status: "starting",
          title: "Fix the flaky auth test",
          providerInstanceId: CODEX,
          model: "gpt-5",
        },
        { status: "idle", title: "Scratch", providerInstanceId: CODEX, model: "gpt-5" },
      ]);
      const [first, second] = result.threads;
      expect(first!.threadId).toMatch(/^mcp-[0-9a-f]{32}$/);
      expect(second!.threadId).not.toBe(first!.threadId);

      const commands = yield* Ref.get(harness.commands);
      expect(
        commands.map((command) => [command.type, "threadId" in command && command.threadId]),
      ).toEqual([
        ["thread.create", first!.threadId],
        ["thread.turn.start", first!.threadId],
        ["thread.create", second!.threadId],
      ]);
      expect(commands[0]).toMatchObject({
        projectId: PROJECT_ID,
        modelSelection: { instanceId: CODEX, model: "gpt-5" },
        runtimeMode: "auto",
        interactionMode: "default",
        branch: "feature/work",
        worktreePath: "/workspace/project-feature",
      });
      // A title taken from the prompt is only a seed the first turn may replace.
      expect(commands[1]).toMatchObject({
        message: { role: "user", text: "Fix the flaky auth test", attachments: [] },
        titleSeed: "Fix the flaky auth test",
      });
    }),
  );

  it.effect("keeps an explicit title and targets another provider and model", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.createThreads({
        threads: [
          {
            prompt: "Review the diff",
            title: "Review",
            target: { driverKind: ProviderDriverKind.make("claudeAgent") },
            runtimeMode: "approval-required",
            interactionMode: "plan",
          },
          {
            prompt: "Think hard",
            target: { model: "gpt-5-mini", options: { reasoningEffort: "high" } },
          },
        ],
      });
      expect(result.threads).toMatchObject([
        { title: "Review", providerInstanceId: CLAUDE, model: "claude-opus" },
        { providerInstanceId: CODEX, model: "gpt-5-mini" },
      ]);
      const commands = yield* Ref.get(harness.commands);
      expect(commands[0]).toMatchObject({
        type: "thread.create",
        modelSelection: { instanceId: CLAUDE, model: "claude-opus" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      expect(commands[1]).not.toHaveProperty("titleSeed");
      expect(commands[2]).toMatchObject({
        type: "thread.create",
        modelSelection: {
          instanceId: CODEX,
          model: "gpt-5-mini",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
    }),
  );

  it.effect("rejects the whole batch before creating anything when one entry is invalid", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const cases = [
        [{ runtimeMode: "full-access" }, "runtime_mode_escalation_denied"],
        [{ target: { model: "gpt-9" } }, "model_unavailable"],
        [{ target: { options: { reasoningEffort: "max" } } }, "invalid_request"],
        [
          { target: { providerInstanceId: ProviderInstanceId.make("gone") } },
          "provider_unavailable",
        ],
      ] as const;
      for (const [entry, code] of cases) {
        const error = yield* harness.createThreadsFailure({
          threads: [{ prompt: "Valid first entry" }, { prompt: "Second", ...entry }],
        });
        expect(error).toMatchObject({ _tag: "OrchestratorMcpFailure", code });
      }
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("refuses a plan-mode parent's request for a default-mode thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ parent: makeThread({ interactionMode: "plan" }) });
      const error = yield* harness.createThreadsFailure({
        threads: [{ prompt: "Build it", interactionMode: "default" }],
      });
      expect(error.code).toBe("interaction_mode_escalation_denied");
    }),
  );

  it.effect("replays a retried clientRequestId and reports what the first call created", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const first = yield* harness.createThreads({
        threads: [{ prompt: "Do it", title: "First title" }],
        clientRequestId: "req-1",
      });
      const retry = yield* harness.createThreads({
        threads: [{ prompt: "Do it", title: "Changed title" }],
        clientRequestId: "req-1",
      });
      expect(retry.threads[0]).toEqual(first.threads[0]);
      expect(retry.threads[0]!.title).toBe("First title");
      expect((yield* Ref.get(harness.commands)).length).toBe(2);

      // Another request id, or the same id from another provider session, is new work.
      const other = yield* harness.createThreads({
        threads: [{ prompt: "Do it" }],
        clientRequestId: "req-2",
      });
      const otherSession = yield* harness.createThreads(
        { threads: [{ prompt: "Do it" }], clientRequestId: "req-1" },
        invocation(["orchestration"], "provider-session-2"),
      );
      expect(other.threads[0]!.threadId).not.toBe(first.threads[0]!.threadId);
      expect(otherSession.threads[0]!.threadId).not.toBe(first.threads[0]!.threadId);
    }),
  );

  it.effect("starts the first turn on retry after a transient failure", () =>
    Effect.gen(function* () {
      let storageDown = true;
      const harness = yield* makeHarness({
        failTransiently: (command) => command.type === "thread.turn.start" && storageDown,
      });
      const request = { threads: [{ prompt: "Do it" }], clientRequestId: "req-1" };
      const error = yield* harness.createThreadsFailure(request);
      expect(error.code).toBe("orchestration_error");
      expect(error.message).toBe(
        "Unable to start thread 1: T3 Code could not read or write its database. Retry with the same clientRequestId.",
      );

      storageDown = false;
      const retry = yield* harness.createThreads(request);
      expect(retry.threads[0]!.status).toBe("starting");
      expect((yield* Ref.get(harness.commands)).map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
      ]);
    }),
  );

  it.effect("keeps reporting a rejected first turn on retry instead of claiming success", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        reject: (command) =>
          command.type === "thread.turn.start"
            ? new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Thread is archived.",
              })
            : null,
      });
      const request = { threads: [{ prompt: "Do it" }], clientRequestId: "req-1" };
      const first = yield* harness.createThreadsFailure(request);
      const retry = yield* harness.createThreadsFailure(request);
      expect(first.message).toBe(
        "Unable to start thread 1: T3 Code rejected the thread.turn.start command.",
      );
      // The engine stored the rejection, so the retry fails with a hint instead
      // of reporting a thread without its first turn as started.
      expect(retry.message).toContain("Retry with a new clientRequestId.");
    }),
  );
});

describe("orchestrator toolkit: orchestrator_capabilities", () => {
  it.effect("reports providers, inherited settings, and that only thread creation exists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        providers: [
          makeProvider(CODEX, "codex", ["gpt-5"]),
          makeProvider(CLAUDE, "claudeAgent", ["claude-opus"], {
            auth: { status: "unauthenticated" },
          }),
        ],
      });
      const part = yield* harness.run("orchestrator_capabilities", {});
      const result = part.result as Tool.Success<
        typeof OrchestratorToolkit.tools.orchestrator_capabilities
      >;
      expect(result).toMatchObject({
        parentThreadId: THREAD_ID,
        inheritedProviderInstanceId: CODEX,
        inheritedModel: "gpt-5",
        runtimeMode: "auto",
        interactionMode: "default",
        features: { batchThreadCreation: true, appOwnedSubagents: false, maxBatchThreads: 20 },
      });
      expect(result.providers).toMatchObject([
        { providerInstanceId: CODEX, canRunChildTask: true, constraints: [] },
        {
          providerInstanceId: CLAUDE,
          canRunChildTask: false,
          constraints: ["Provider is not authenticated."],
        },
      ]);
      expect(result.providers[0]!.models[0]!.options?.[0]?.id).toBe("reasoningEffort");
    }),
  );
});
