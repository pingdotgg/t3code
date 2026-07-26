import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type ProviderSessionRuntimeStatus,
  type TerminalCloseInput,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ThreadArchiveReactorLive } from "./ThreadArchiveReactor.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const createdAt = "2026-01-01T00:00:00.000Z";
const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const unsupported = () => Effect.die("unsupported in thread archive reactor test");

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

interface ArchiveHarnessCalls {
  readonly interrupted: Array<ThreadId>;
  readonly closedTerminals: Array<TerminalCloseInput>;
  readonly events: Array<OrchestrationEvent>;
}

/**
 * Builds the per-test layer graph and call log. `harness` must be run inside
 * `Effect.scoped` with `layer` provided: the reactor and the domain-event tap
 * are scope-bound and shut down with the test.
 */
function makeArchiveHarness(input?: {
  readonly bindings?: Readonly<Record<string, ProviderSessionRuntimeStatus>>;
}) {
  const calls: ArchiveHarnessCalls = {
    interrupted: [],
    closedTerminals: [],
    events: [],
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
    stopSession: () => unsupported(),
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
    prefix: "t3-thread-archive-reactor-test-",
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

  const reactorLayer = ThreadArchiveReactorLive.pipe(
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
    const archiveReactor = yield* ThreadArchiveReactor;
    yield* archiveReactor.start();
    yield* Effect.forkScoped(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        Effect.sync(() => {
          calls.events.push(event);
        }),
      ),
    );

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

    const archivedThreadIds = () =>
      calls.events
        .filter((event) => event.type === "thread.archived")
        .map((event) => event.payload.threadId as ThreadId);
    const sessionStopRequestedThreadIds = () =>
      calls.events
        .filter((event) => event.type === "thread.session-stop-requested")
        .map((event) => event.payload.threadId as ThreadId);

    return {
      calls,
      engine,
      archiveReactor,
      createProject,
      createThread,
      archivedThreadIds,
      sessionStopRequestedThreadIds,
    };
  });

  return { calls, layer, harness };
}

it.live(
  "interrupts and stops sessions, closes terminals, and cascades archive to child threads",
  () => {
    const { layer, harness } = makeArchiveHarness({
      bindings: {
        "thread-parent": "running",
        "thread-child": "running",
      },
    });
    return Effect.gen(function* () {
      const h = yield* harness;
      yield* h.createProject("project-archive");
      yield* h.createThread({
        commandId: "cmd-parent-create",
        threadId: "thread-parent",
        projectId: "project-archive",
      });
      yield* h.createThread({
        commandId: "cmd-child-create",
        threadId: "thread-child",
        projectId: "project-archive",
        parentThreadId: "thread-parent",
      });

      yield* h.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-parent-archive"),
        threadId: ThreadId.make("thread-parent"),
      });

      yield* waitFor(
        () =>
          h.archivedThreadIds().includes(ThreadId.make("thread-child")) &&
          h.sessionStopRequestedThreadIds().includes(ThreadId.make("thread-child")) &&
          h.calls.closedTerminals.some((input) => input.threadId === ThreadId.make("thread-child")),
      );

      const parent = ThreadId.make("thread-parent");
      const child = ThreadId.make("thread-child");
      expect(h.archivedThreadIds()).toEqual([parent, child]);
      expect(h.sessionStopRequestedThreadIds()).toEqual([parent, child]);
      expect(h.calls.interrupted).toEqual([parent, child]);
      expect(
        h.calls.closedTerminals.every(
          (input) => input.deleteHistory === undefined || input.deleteHistory === false,
        ),
      ).toBe(true);

      const childArchiveEvent = h.calls.events.find(
        (event) => event.type === "thread.archived" && event.payload.threadId === child,
      );
      expect(childArchiveEvent?.commandId).toBe(
        CommandId.make("archive-cascade:cmd-parent-archive:thread-child"),
      );
    }).pipe(Effect.scoped, Effect.provide(layer));
  },
);

it.live("skips turn interrupt and session stop when the session binding is already stopped", () => {
  const { layer, harness } = makeArchiveHarness({
    bindings: {
      "thread-parent": "stopped",
    },
  });
  return Effect.gen(function* () {
    const h = yield* harness;
    yield* h.createProject("project-archive-stopped");
    yield* h.createThread({
      commandId: "cmd-stopped-parent-create",
      threadId: "thread-parent",
      projectId: "project-archive-stopped",
    });

    yield* h.engine.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("cmd-stopped-parent-archive"),
      threadId: ThreadId.make("thread-parent"),
    });

    yield* waitFor(() =>
      h.calls.closedTerminals.some((input) => input.threadId === ThreadId.make("thread-parent")),
    );
    yield* h.archiveReactor.drain;

    expect(h.calls.interrupted).toEqual([]);
    expect(h.sessionStopRequestedThreadIds()).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.live("does not re-archive an already-archived child when the parent archive cascades", () => {
  const { layer, harness } = makeArchiveHarness({
    bindings: {
      "thread-parent": "running",
      "thread-child": "stopped",
    },
  });
  return Effect.gen(function* () {
    const h = yield* harness;
    yield* h.createProject("project-archive-idempotent");
    yield* h.createThread({
      commandId: "cmd-idem-parent-create",
      threadId: "thread-parent",
      projectId: "project-archive-idempotent",
    });
    yield* h.createThread({
      commandId: "cmd-idem-child-create",
      threadId: "thread-child",
      projectId: "project-archive-idempotent",
      parentThreadId: "thread-parent",
    });

    // The child was already archived (e.g. auto-archive of a completed
    // sub-agent) before the parent archive.
    yield* h.engine.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("cmd-child-archive-first"),
      threadId: ThreadId.make("thread-child"),
    });
    yield* waitFor(() => h.archivedThreadIds().includes(ThreadId.make("thread-child")));
    yield* h.archiveReactor.drain;

    yield* h.engine.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("cmd-parent-archive-idem"),
      threadId: ThreadId.make("thread-parent"),
    });
    yield* waitFor(() =>
      h.calls.closedTerminals.some((input) => input.threadId === ThreadId.make("thread-parent")),
    );
    yield* h.archiveReactor.drain;

    // The cascade must skip the already-archived child: exactly one archived
    // event and one terminal close per thread, and a duplicate archive of the
    // child would have been rejected by the decider instead of looping.
    expect(
      h.archivedThreadIds().filter((threadId) => threadId === ThreadId.make("thread-child")),
    ).toHaveLength(1);
    expect(
      h.calls.closedTerminals.filter((input) => input.threadId === ThreadId.make("thread-child")),
    ).toHaveLength(1);
    expect(h.archivedThreadIds()).toContain(ThreadId.make("thread-parent"));
  }).pipe(Effect.scoped, Effect.provide(layer));
});
