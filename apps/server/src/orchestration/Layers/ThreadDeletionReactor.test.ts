import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderSessionRuntimeStatus,
  type TerminalCloseInput,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type * as Duration from "effect/Duration";

import { ServerConfig } from "../../config.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryShape,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadArchiveReactor } from "../Services/ThreadArchiveReactor.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ThreadArchiveReactorLive } from "./ThreadArchiveReactor.ts";
import {
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

const reactorTestThreadId = ThreadId.make("thread-deletion-reactor-test");

it.effect("logCleanupCauseUnlessInterrupted swallows ordinary cleanup failures", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId: reactorTestThreadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  }),
);

it.effect("logCleanupCauseUnlessInterrupted preserves interrupt causes", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId: reactorTestThreadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  }),
);

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const createdAt = "2026-01-01T00:00:00.000Z";
const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const unsupported = () => Effect.die("unsupported in thread reactor test");

class WaitForConditionError extends Data.TaggedError("WaitForConditionError")<{
  readonly message: string;
}> {}

const waitFor = (
  predicate: () => boolean,
  timeout: Duration.Input = "5 seconds",
): Effect.Effect<void, WaitForConditionError> =>
  Effect.sync(predicate).pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new WaitForConditionError({ message: "Condition not met" }),
    ),
    Effect.retry(Schedule.spaced("15 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new WaitForConditionError({ message: "Timed out waiting for condition" })),
        onSome: () => Effect.void,
      }),
    ),
  );

interface ReactorHarnessCalls {
  readonly interrupted: Array<ThreadId>;
  readonly stopped: Array<ThreadId>;
  readonly closedTerminals: Array<TerminalCloseInput>;
}

/**
 * Builds the per-test layer graph and call log. `harness` must be run inside
 * `Effect.scoped` with `layer` provided: both reactors are scope-bound and
 * shut down with the test.
 */
function makeReactorHarness(input?: {
  readonly bindings?: Readonly<Record<string, ProviderSessionRuntimeStatus>>;
}) {
  const calls: ReactorHarnessCalls = {
    interrupted: [],
    stopped: [],
    closedTerminals: [],
  };
  const bindings = new Map<string, ProviderRuntimeBinding>(
    Object.entries(input?.bindings ?? {}).map(([threadId, status]) => [
      threadId,
      {
        threadId: ThreadId.make(threadId),
        provider: ProviderDriverKind.make("codex"),
        status,
      },
    ]),
  );

  const providerService: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: (request) =>
      Effect.sync(() => {
        calls.interrupted.push(request.threadId);
      }),
    stopTask: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: (request) =>
      Effect.sync(() => {
        calls.stopped.push(request.threadId);
      }),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => unsupported(),
    getInstanceInfo: () => unsupported(),
    rollbackConversation: () => unsupported(),
    streamEvents: Stream.empty,
  };

  const providerSessionDirectory: ProviderSessionDirectoryShape = {
    upsert: () => unsupported(),
    getProvider: () => unsupported(),
    getBinding: (threadId) => Effect.succeed(Option.fromNullishOr(bindings.get(threadId))),
    listThreadIds: () => unsupported(),
    listBindings: () => unsupported(),
  };

  const terminalManagerLayer = Layer.succeed(TerminalManager.TerminalManager, {
    open: () => unsupported(),
    attachStream: () => unsupported(),
    write: () => unsupported(),
    resize: () => unsupported(),
    clear: () => unsupported(),
    restart: () => unsupported(),
    close: (closeInput) =>
      Effect.sync(() => {
        calls.closedTerminals.push(closeInput);
      }),
    subscribe: () => unsupported(),
    subscribeMetadata: () => unsupported(),
  } satisfies TerminalManager.TerminalManager["Service"]);

  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-thread-deletion-reactor-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  const reactorLayer = Layer.mergeAll(ThreadDeletionReactorLive, ThreadArchiveReactorLive).pipe(
    Layer.provide(
      Layer.mergeAll(
        orchestrationLayer,
        Layer.succeed(ProviderService, providerService),
        Layer.succeed(ProviderSessionDirectory, providerSessionDirectory),
        terminalManagerLayer,
      ),
    ),
  );

  const layer = Layer.mergeAll(reactorLayer, orchestrationLayer);

  const harness = Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const deletionReactor = yield* ThreadDeletionReactor;
    const archiveReactor = yield* ThreadArchiveReactor;
    yield* Effect.all([deletionReactor.start(), archiveReactor.start()]);

    const createProject = (projectId: string) =>
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`cmd-${projectId}-create`),
        projectId: asProjectId(projectId),
        title: projectId,
        workspaceRoot: `/tmp/${projectId}`,
        defaultModelSelection,
        createdAt,
      });

    const createThread = (threadInput: {
      readonly commandId: string;
      readonly threadId: string;
      readonly projectId: string;
      readonly parentThreadId?: string;
    }) =>
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(threadInput.commandId),
        threadId: ThreadId.make(threadInput.threadId),
        projectId: asProjectId(threadInput.projectId),
        title: threadInput.threadId,
        modelSelection: defaultModelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        parentThreadId: threadInput.parentThreadId
          ? ThreadId.make(threadInput.parentThreadId)
          : null,
        createdAt,
      });

    return {
      calls,
      engine,
      deletionReactor,
      archiveReactor,
      createProject,
      createThread,
    };
  });

  return { calls, layer, harness };
}

it.live(
  "interrupts and stops child sessions and terminals when a thread with children is deleted",
  () => {
    const { layer, harness } = makeReactorHarness({
      bindings: {
        "thread-parent": "running",
        "thread-child": "running",
      },
    });
    return Effect.gen(function* () {
      const h = yield* harness;
      yield* h.createProject("project-delete");
      yield* h.createThread({
        commandId: "cmd-parent-create",
        threadId: "thread-parent",
        projectId: "project-delete",
      });
      yield* h.createThread({
        commandId: "cmd-child-create",
        threadId: "thread-child",
        projectId: "project-delete",
        parentThreadId: "thread-parent",
      });
      yield* h.createThread({
        commandId: "cmd-grandchild-create",
        threadId: "thread-grandchild",
        projectId: "project-delete",
        parentThreadId: "thread-child",
      });

      yield* h.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-parent-delete"),
        threadId: ThreadId.make("thread-parent"),
      });

      // The cascade recurses through child thread.deleted events, so the whole
      // subtree (parent, child, grandchild) is interrupted, stopped, and has its
      // terminals closed with history deleted.
      yield* waitFor(
        () =>
          ["thread-parent", "thread-child", "thread-grandchild"].every((threadId) =>
            h.calls.stopped.includes(ThreadId.make(threadId)),
          ) &&
          ["thread-parent", "thread-child", "thread-grandchild"].every((threadId) =>
            h.calls.closedTerminals.some(
              (input) => input.threadId === ThreadId.make(threadId) && input.deleteHistory === true,
            ),
          ),
      );

      expect(h.calls.interrupted).toEqual([
        ThreadId.make("thread-parent"),
        ThreadId.make("thread-child"),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  },
);

it.live("does not loop or re-delete children when a thread is deleted twice", () => {
  const { layer, harness } = makeReactorHarness({
    bindings: {
      "thread-parent": "running",
      "thread-child": "running",
    },
  });
  return Effect.gen(function* () {
    const h = yield* harness;
    yield* h.createProject("project-double-delete");
    yield* h.createThread({
      commandId: "cmd-double-parent-create",
      threadId: "thread-parent",
      projectId: "project-double-delete",
    });
    yield* h.createThread({
      commandId: "cmd-double-child-create",
      threadId: "thread-child",
      projectId: "project-double-delete",
      parentThreadId: "thread-parent",
    });

    yield* h.engine.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("cmd-parent-delete-1"),
      threadId: ThreadId.make("thread-parent"),
    });
    // Soft-deleted threads still satisfy the decider's requireThread, so a
    // duplicate delete emits a second thread.deleted event. The cascade must
    // skip the already-deleted child instead of looping.
    yield* h.engine.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("cmd-parent-delete-2"),
      threadId: ThreadId.make("thread-parent"),
    });

    yield* waitFor(
      () =>
        h.calls.stopped.filter((threadId) => threadId === ThreadId.make("thread-parent")).length ===
          2 &&
        h.calls.stopped.filter((threadId) => threadId === ThreadId.make("thread-child")).length ===
          1,
    );
    yield* h.deletionReactor.drain;

    expect(
      h.calls.stopped.filter((threadId) => threadId === ThreadId.make("thread-child")),
    ).toHaveLength(1);
    expect(
      h.calls.closedTerminals.filter((input) => input.threadId === ThreadId.make("thread-child")),
    ).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(layer));
});
