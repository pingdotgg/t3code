import {
  CommandId,
  type KompasError,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ThreadId,
  type Workstream,
  type WorkstreamThread,
  type WorkstreamThreadState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { forkParked } from "../serverActivation.ts";
import { KompasDatabase, kompasError, storageError } from "./KompasDatabase.ts";
import { MemoryService, projectScope } from "./MemoryService.ts";
import {
  type StoredWorkstream,
  type WorkstreamFields,
  WorkstreamStore,
} from "./WorkstreamStore.ts";

export class WorkstreamService extends Context.Service<
  WorkstreamService,
  {
    readonly list: Effect.Effect<ReadonlyArray<Workstream>, KompasError>;
    readonly create: (
      input: WorkstreamFields & { readonly coordinatorModel: ModelSelection },
    ) => Effect.Effect<
      { readonly id: string; readonly coordinatorThreadId: ThreadId },
      KompasError
    >;
    readonly remove: (id: string) => Effect.Effect<void, KompasError>;
    readonly resolveSuggestion: (input: {
      readonly id: string;
      readonly approve: boolean;
    }) => Effect.Effect<void, KompasError>;
    readonly answerDecision: (input: {
      readonly id: string;
      readonly answer: string;
    }) => Effect.Effect<void, KompasError>;
    /** Fails while the project's limits keep its coordinator from starting another thread. */
    readonly claimThreadStart: (coordinatorThreadId: ThreadId) => Effect.Effect<void, KompasError>;
    /** Re-sends the snapshot when a project's thread changes state. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kompas/WorkstreamService") {}

const WORKING_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);

const stateOf = (shell: OrchestrationV2ThreadShell, resolved: boolean): WorkstreamThreadState => {
  if (shell.pendingRuntimeRequest !== null) return "needs_input";
  if (WORKING_STATUSES.has(shell.status)) return "working";
  if (resolved) return "resolved";
  return shell.status === "failed" ? "failed" : "idle";
};

const lastLine = (text: string | undefined) => {
  const line = text
    ?.split("\n")
    .map((candidate) => candidate.trim())
    .findLast((candidate) => candidate !== "");
  return line === undefined ? null : line.slice(0, 160);
};

const make = Effect.gen(function* () {
  const store = yield* WorkstreamStore;
  const database = yield* KompasDatabase;
  const memory = yield* MemoryService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;

  // Threads whose events move a project's board, learned whenever the list is read.
  let followed: ReadonlySet<string> = new Set();

  const threadsOf = Effect.fn("WorkstreamService.threadsOf")(function* (
    workstream: StoredWorkstream,
  ) {
    const records = yield* threads
      .getThreadRecords(workstream.coordinatorThreadId, ["subagents"])
      .pipe(Effect.orElseSucceed(() => undefined));
    const childIds = new Set(
      (records?.subagents ?? []).flatMap((task) =>
        task.origin === "app_owned" && task.childThreadId !== null ? [task.childThreadId] : [],
      ),
    );
    if (childIds.size === 0) return [];
    const resolved = yield* store.resolvedThreads(workstream.id);
    const shells = yield* Effect.forEach(childIds, (id) =>
      threads.getThreadShell(id).pipe(Effect.orElseSucceed(() => null)),
    );
    return shells
      .filter(
        (shell): shell is OrchestrationV2ThreadShell => shell !== null && shell.deletedAt === null,
      )
      .map((shell): WorkstreamThread => ({
        threadId: shell.id,
        title: shell.title,
        model: shell.modelSelection.model,
        state: stateOf(shell, resolved.has(shell.id)),
        lastLine: lastLine(shell.latestVisibleMessage?.text),
        updatedAt: DateTime.formatIso(shell.updatedAt),
      }))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  });

  const list = Effect.gen(function* () {
    const workstreams = yield* Effect.forEach(yield* store.list, (workstream) =>
      Effect.gen(function* () {
        const { suggestions, decisions } = yield* store.asks(workstream.id);
        return {
          ...workstream,
          threads: yield* threadsOf(workstream),
          library: yield* store.library(workstream.id),
          suggestions,
          decisions,
        } satisfies Workstream;
      }),
    );
    followed = new Set(
      workstreams.flatMap((workstream) => [
        workstream.coordinatorThreadId,
        ...workstream.threads.map((thread) => thread.threadId),
      ]),
    );
    return workstreams;
  }).pipe(Effect.withSpan("WorkstreamService.list"));

  const create: WorkstreamService["Service"]["create"] = Effect.fn("WorkstreamService.create")(
    function* ({ coordinatorModel, ...fields }) {
      const id = yield* database.newId;
      const { projectId } = yield* folders.ensureScratchProject.pipe(
        Effect.mapError((cause) => kompasError("storage", cause.message, cause)),
      );
      // The store row first, so the coordinator's very first session gets its profile.
      const coordinatorThreadId = ThreadId.make(id);
      const workstream = yield* store.create({ ...fields, coordinatorThreadId });
      yield* launcher
        .launch({
          commandId: CommandId.make(`kompas:workstream:${id}`),
          threadId: coordinatorThreadId,
          projectId,
          title: fields.title,
          titleRenamed: true,
          modelSelection: coordinatorModel,
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError((cause) =>
            kompasError("storage", "Could not start the project's conversation.", cause),
          ),
          Effect.tapError(() => store.remove(workstream.id).pipe(Effect.ignore)),
        );
      return { id: workstream.id, coordinatorThreadId };
    },
  );

  const remove = Effect.fn("WorkstreamService.remove")(function* (id: string) {
    yield* store.remove(id);
    yield* memory.removeScope(projectScope(id));
  });

  const tellCoordinator = Effect.fn("WorkstreamService.tellCoordinator")(function* (
    workstreamId: string,
    text: string,
  ) {
    const workstream = yield* store.get(workstreamId);
    const thread = yield* threads
      .getThreadShell(workstream.coordinatorThreadId)
      .pipe(Effect.mapError(storageError));
    if (thread === null)
      return yield* kompasError("not-found", "This project's conversation is gone.");
    const id = yield* database.newId;
    yield* threads
      .sendToThread({
        projectId: thread.projectId,
        commandId: CommandId.make(`kompas:coordinator:${id}`),
        threadId: thread.id,
        messageId: MessageId.make(`message:kompas:${id}`),
        text,
        attachments: [],
        mode: "auto",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(
        Effect.mapError((cause) =>
          kompasError("storage", "Could not reach the project's coordinator.", cause),
        ),
      );
  });

  const resolveSuggestion: WorkstreamService["Service"]["resolveSuggestion"] = Effect.fn(
    "WorkstreamService.resolveSuggestion",
  )(function* (input) {
    const suggestion = yield* store.takeAsk(input.id, "suggestion");
    if (!input.approve) return;
    yield* store.addGrant(suggestion.workstreamId, suggestion.title);
    yield* tellCoordinator(
      suggestion.workstreamId,
      `Start the thread "${suggestion.title}": ${suggestion.task}`,
    );
  });

  const answerDecision: WorkstreamService["Service"]["answerDecision"] = Effect.fn(
    "WorkstreamService.answerDecision",
  )(function* (input) {
    const decision = yield* store.takeAsk(input.id, "decision");
    yield* tellCoordinator(decision.workstreamId, `${decision.question} ${input.answer}`);
  });

  const claimThreadStart: WorkstreamService["Service"]["claimThreadStart"] = Effect.fn(
    "WorkstreamService.claimThreadStart",
  )(function* (coordinatorThreadId) {
    const workstream = yield* store.byCoordinator(coordinatorThreadId);
    if (workstream === undefined) return;
    const working = (yield* threadsOf(workstream)).filter(
      (thread) => thread.state === "working" || thread.state === "needs_input",
    );
    if (working.length >= workstream.maxParallelThreads) {
      return yield* kompasError(
        "limit",
        `${working.length} of ${workstream.maxParallelThreads} threads are already working. Start this one when another finishes.`,
      );
    }
    if (workstream.askBeforeStart && !(yield* store.takeGrant(workstream.id))) {
      return yield* kompasError(
        "limit",
        "The user approves every thread in this project. Propose it with suggest_threads and end your turn.",
      );
    }
  });

  const concerns = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "run.updated":
      case "run.created":
      case "runtime-request.updated":
      case "subagent.updated":
        return (
          Predicate.hasProperty(event, "threadId") &&
          typeof event.threadId === "string" &&
          followed.has(event.threadId)
        );
      default:
        return false;
    }
  };

  const start: WorkstreamService["Service"]["start"] = Effect.fn("WorkstreamService.start")(
    function* () {
      yield* list.pipe(Effect.ignore);
      yield* forkParked(
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(concerns),
          Stream.debounce("300 millis"),
          Stream.runForEach(() => database.notifyChanged),
          Effect.catchCause((cause) =>
            Effect.logWarning("Following project threads failed.", { cause }),
          ),
        ),
      );
    },
  );

  return WorkstreamService.of({
    list,
    create,
    remove,
    resolveSuggestion,
    answerDecision,
    claimThreadStart,
    start,
  });
});

export const layer = Layer.effect(WorkstreamService, make);
