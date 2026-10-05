/**
 * FleetService - runs one Home operation in this environment.
 *
 * Every T3 server has it. Home's own server calls it in process; the user's
 * other environments receive the same operations over `fleet.invoke`, relayed
 * by the desktop renderer. It acts with the reach of the user's client: any
 * project, no calling-project limit. Nothing here deletes data.
 *
 * @module FleetService
 */
import {
  CommandId,
  type FleetActor,
  type FleetInput,
  type FleetInvokeInput,
  type FleetOperation,
  type FleetResult,
  isHomeLaunchedThreadId,
  ProviderRequestKind,
  MessageId,
  type ProjectId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  listItemFromShell,
  providerCapabilities,
  readThreadPage,
  threadManagementFailure,
  threadSettlement,
} from "../mcp/OrchestratorMcpService.ts";
import { resultFromThread } from "../mcp/ThreadMetadataMcpService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";

const DEFAULT_LIST_LIMIT = 50;

export class FleetService extends Context.Service<
  FleetService,
  {
    /** Runs one operation and returns its result, typed by `FleetResults[op]`. */
    readonly execute: (input: FleetInvokeInput) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  }
>()("t3/home/FleetService") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const orchestrationError = (error: unknown) =>
  failure(
    "orchestration_error",
    error instanceof Error ? error.message : "The operation could not be completed.",
  );

/**
 * Fails when a launch would run in Home's folder, as its project or an
 * existing worktree. That folder's instructions make any agent there act as
 * Home. Every Home launch path calls this.
 */
export const refuseHomeFolder = Effect.fn("FleetService.refuseHomeFolder")(function* (
  services: {
    readonly projects: ProjectService.ProjectService["Service"];
    readonly folders: ManagedProjectFolders.ManagedProjectFolders["Service"];
  },
  input: {
    readonly projectId: ProjectId;
    readonly workspaceStrategy?: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
  },
) {
  const project = yield* services.projects
    .getById(input.projectId)
    .pipe(Effect.mapError(orchestrationError));
  const roots = [
    ...(Option.isSome(project) ? [project.value.workspaceRoot] : []),
    ...(input.workspaceStrategy?.type === "existing_worktree"
      ? [input.workspaceStrategy.worktreePath]
      : []),
  ];
  for (const root of roots) {
    if (yield* services.folders.isInHomeFolder(root)) {
      return yield* failure("invalid_request", "Threads never launch in Home's folder.");
    }
  }
});

type Handlers = {
  readonly [Op in FleetOperation]: (
    input: FleetInput<Op>,
    actor: FleetActor,
  ) => Effect.Effect<FleetResult<Op>, OrchestratorMcpFailure>;
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  // Links in results point at this environment, wherever the call came from.
  const environmentId = (yield* environment.getDescriptor).environmentId;

  // A retried request with the same clientRequestId maps to the same command
  // for the same target thread; another target gets its own command.
  const commandId = (
    actor: FleetActor,
    operation: string,
    target?: { readonly threadId: ThreadId; readonly clientRequestId?: string | undefined },
  ) =>
    (target?.clientRequestId === undefined
      ? crypto.randomUUIDv4.pipe(Effect.orDie)
      : Effect.succeed(
          `${actor.environmentId}:${actor.threadId}:${target.threadId}:${target.clientRequestId}`,
        )
    ).pipe(Effect.map((key) => CommandId.make(`fleet:${operation}:${key}`)));

  const loadShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(threadManagementFailure),
      Effect.flatMap((shell) =>
        shell === null || shell.deletedAt !== null
          ? Effect.fail(failure("thread_not_found", `Thread ${threadId} was not found.`))
          : Effect.succeed(shell),
      ),
    );

  const requireThreadId = (threadId: ThreadId | undefined) =>
    threadId === undefined
      ? Effect.fail(failure("invalid_request", "threadId is required in another environment."))
      : Effect.succeed(threadId);

  const dispatch = (command: OrchestrationV2Command) =>
    threads.dispatch(command).pipe(
      Effect.map((result) => ({ sequence: result.sequence })),
      Effect.mapError(threadManagementFailure),
    );

  const loadRequests = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, ["runtimeRequests", "turnItems"], {
        turnItemTypes: ["user_input_request", "approval_request"],
      })
      .pipe(Effect.mapError(threadManagementFailure));

  const handlers: Handlers = {
    capabilities: () =>
      Effect.gen(function* () {
        const providers = yield* providerRegistry.getProviders;
        const capable = new Set<string>(yield* adapters.list());
        return { providers: providerCapabilities(providers, capable) };
      }),

    "projects.list": (input) =>
      Effect.gen(function* () {
        const snapshot = yield* projects.snapshot.pipe(Effect.mapError(orchestrationError));
        const rows = snapshot.projects.filter((project) => project.deletedAt === null);
        const start = input.cursor ?? 0;
        const end = start + (input.limit ?? 20);
        return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
      }),

    "threads.list": (input, actor) =>
      Effect.gen(function* () {
        // The same default as the regular thread list: subagents unless turned off.
        const includeSubagents = input.includeSubagents !== false;
        const shells =
          input.projectId === undefined
            ? yield* threads.getShellSnapshot().pipe(
                Effect.mapError(threadManagementFailure),
                Effect.map((snapshot) =>
                  snapshot.threads
                    .filter(
                      (thread) =>
                        includeSubagents || thread.lineage.relationshipToParent !== "subagent",
                    )
                    .toSorted(
                      (left, right) =>
                        DateTime.toEpochMillis(right.updatedAt) -
                          DateTime.toEpochMillis(left.updatedAt) || right.id.localeCompare(left.id),
                    ),
                ),
              )
            : yield* threads
                .listProjectThreads({ projectId: input.projectId, includeSubagents })
                .pipe(Effect.mapError(threadManagementFailure));
        const nowMs = yield* Clock.currentTimeMillis;
        const statuses = input.statuses === undefined ? null : new Set(input.statuses);
        const titleContains = input.titleContains?.toLocaleLowerCase();
        const filtered = shells.filter(
          (thread) =>
            thread.deletedAt === null &&
            (statuses === null || statuses.has(thread.activityRunStatus ?? thread.status)) &&
            (input.settled === undefined || threadSettlement(thread).settled === input.settled) &&
            (input.snoozed === undefined || isSnoozed(thread, nowMs) === input.snoozed) &&
            (titleContains === undefined ||
              thread.title.toLocaleLowerCase().includes(titleContains)),
        );
        const cursor = input.cursor ?? 0;
        const page = filtered.slice(cursor, cursor + (input.limit ?? DEFAULT_LIST_LIMIT));
        const next = cursor + page.length;
        return {
          projectId: input.projectId ?? null,
          currentThreadId: filtered.some((thread) => thread.id === actor.threadId)
            ? actor.threadId
            : null,
          threads: page.map((shell) => listItemFromShell(shell, { environmentId, nowMs })),
          nextCursor: next < filtered.length ? next : null,
          total: filtered.length,
        };
      }),

    "threads.read": (input) =>
      Effect.gen(function* () {
        const target = yield* threads
          .getThreadRecords(input.threadId, ["runs", "runtimeRequests", "contextTransfers"])
          .pipe(Effect.mapError(threadManagementFailure));
        if (target.thread.deletedAt !== null) {
          return yield* failure("thread_not_found", `Thread ${input.threadId} was not found.`);
        }
        return (yield* readThreadPage(threads, target, input, environmentId)).result;
      }),

    "threads.launch": (input, actor) =>
      Effect.gen(function* () {
        // Home picks the id so its watch exists first; no caller may pick another kind of id.
        if (input.threadId !== undefined && !isHomeLaunchedThreadId(input.threadId)) {
          return yield* failure(
            "invalid_request",
            "A launched thread id must be a Home launch id.",
          );
        }
        if (
          input.scratch === true &&
          (input.projectId !== undefined || input.workspaceStrategy !== undefined)
        ) {
          return yield* failure(
            "invalid_request",
            "scratch:true picks its own project and folder; omit projectId and workspaceStrategy.",
          );
        }
        const projectId =
          input.scratch === true
            ? (yield* folders.ensureScratchProject.pipe(Effect.mapError(orchestrationError)))
                .projectId
            : input.projectId;
        if (projectId === undefined) {
          return yield* failure("invalid_request", "Pass projectId or scratch:true.");
        }
        yield* refuseHomeFolder(
          { projects, folders },
          { projectId, workspaceStrategy: input.workspaceStrategy },
        );
        const current = yield* settings.getSettings.pipe(Effect.mapError(orchestrationError));
        const modelSelection = input.modelSelection ?? current.defaultModelSelection;
        if (modelSelection === null) {
          return yield* failure(
            "invalid_request",
            "Pass modelSelection; this environment has no default model.",
          );
        }
        const id = yield* commandId(actor, "launch");
        const messageId = MessageId.make(id);
        const result = yield* launches
          .launch({
            commandId: id,
            threadId: input.threadId ?? ThreadId.make(id),
            projectId,
            title: input.title,
            modelSelection,
            runtimeMode: input.runtimeMode ?? current.defaultRuntimeMode,
            interactionMode: input.interactionMode ?? "default",
            workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
            ...(input.message === undefined
              ? {}
              : {
                  initialMessage: {
                    messageId,
                    senderThreadId: actor.threadId,
                    text: input.message,
                    attachments: [],
                  },
                }),
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(orchestrationError));
        const thread = result.projection.thread;
        const run = result.projection.runs.find(
          (candidate) => candidate.userMessageId === messageId,
        );
        return {
          threadId: thread.id,
          link: formatThreadLink({ environmentId, threadId: thread.id, title: thread.title }),
          projectId: thread.projectId,
          modelSelection: thread.modelSelection,
          runId: run?.id ?? null,
          status: run?.status ?? null,
        };
      }),

    "threads.send": (input, actor) =>
      Effect.gen(function* () {
        const shell = yield* loadShell(input.threadId);
        const id = yield* commandId(actor, "send", input);
        const messageId = MessageId.make(id);
        const result = yield* threads
          .sendToThread({
            projectId: shell.projectId,
            commandId: id,
            threadId: input.threadId,
            senderThreadId: actor.threadId,
            messageId,
            text: input.message,
            attachments: [],
            mode: input.mode ?? "auto",
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(threadManagementFailure));
        return {
          threadId: input.threadId,
          messageId,
          runId: result.run.id,
          status: result.run.status,
          delivery: result.delivery,
        };
      }),

    "threads.interrupt": (input, actor) =>
      Effect.gen(function* () {
        const shell = yield* loadShell(input.threadId);
        const result = yield* threads
          .interruptThread({
            projectId: shell.projectId,
            commandId: yield* commandId(actor, "interrupt", input),
            threadId: input.threadId,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          })
          .pipe(Effect.mapError(threadManagementFailure));
        if (result.type === "no_active_run") {
          return { threadId: input.threadId, runId: null, status: "no_active_run" as const };
        }
        return {
          threadId: input.threadId,
          runId: result.run.id,
          status:
            result.type === "already_terminal"
              ? result.run.status
              : ("interrupt_requested" as const),
        };
      }),

    "threads.organize": (input, actor) =>
      Effect.gen(function* () {
        const threadId = yield* requireThreadId(input.threadId);
        yield* loadShell(threadId);
        const common = { commandId: yield* commandId(actor, "organize"), threadId };
        switch (input.action) {
          case "snooze":
            if (input.snoozedUntil === undefined) {
              return yield* failure("invalid_request", "snooze requires snoozedUntil.");
            }
            return yield* dispatch({
              ...common,
              type: "thread.snooze",
              snoozedUntil: input.snoozedUntil,
            });
          case "unsnooze":
          case "unsettle":
            return yield* dispatch({ ...common, type: `thread.${input.action}`, reason: "user" });
          case "mark_unread":
            return yield* dispatch({ ...common, type: "thread.mark-unread" });
          default:
            return yield* dispatch({ ...common, type: `thread.${input.action}` });
        }
      }),

    "threads.rename": (input, actor) =>
      Effect.gen(function* () {
        yield* loadShell(input.threadId);
        const id = yield* commandId(actor, "rename", input);
        const dispatched = yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: id,
            threadId: input.threadId,
            title: input.title,
          })
          .pipe(Effect.mapError(threadManagementFailure));
        const updated = dispatched.storedEvents.find(
          (stored) => stored.event.type === "thread.metadata-updated",
        );
        if (updated === undefined || updated.event.type !== "thread.metadata-updated") {
          return yield* failure("orchestration_error", "The rename produced no thread state.");
        }
        return resultFromThread({
          action: "rename",
          commandId: id,
          sequence: dispatched.sequence,
          thread: updated.event.payload,
        });
      }),

    "requests.list": (input) =>
      Effect.gen(function* () {
        const threadId = yield* requireThreadId(input.threadId);
        const { runtimeRequests } = yield* loadRequests(threadId);
        const pending = runtimeRequests.filter((request) => request.status === "pending");
        return {
          requestIds: pending
            .filter((request) => request.kind === "user_input")
            .map((request) => request.id),
          approvalRequestIds: pending
            .filter((request) => isApprovalKind(request.kind))
            .map((request) => request.id),
        };
      }),

    "requests.read": (input) =>
      Effect.gen(function* () {
        const threadId = yield* requireThreadId(input.threadId);
        const { runtimeRequests, turnItems } = yield* loadRequests(threadId);
        const request = runtimeRequests.find(
          (candidate) => candidate.id === input.requestId && candidate.status === "pending",
        );
        const item = turnItems.find(
          (candidate) =>
            (candidate.type === "user_input_request" || candidate.type === "approval_request") &&
            candidate.requestId === input.requestId,
        );
        if (request === undefined || item === undefined) {
          return yield* failure("invalid_request", "The pending request was not found.");
        }
        if (item.type === "user_input_request") {
          return {
            requestId: input.requestId,
            kind: "question" as const,
            questions: item.questions,
          };
        }
        if (item.type !== "approval_request") {
          return yield* failure("invalid_request", "The pending request was not found.");
        }
        return {
          requestId: input.requestId,
          kind: "approval" as const,
          questions: [],
          approval: {
            requestKind: item.requestKind,
            prompt: item.prompt ?? null,
            appName: item.appName ?? null,
            options: item.options ?? [],
          },
        };
      }),

    "requests.respond": (input, actor) =>
      Effect.gen(function* () {
        const threadId = yield* requireThreadId(input.threadId);
        const { runtimeRequests } = yield* loadRequests(threadId);
        const request = runtimeRequests.find(
          (candidate) => candidate.id === input.requestId && candidate.status === "pending",
        );
        if (request === undefined) {
          return yield* failure("invalid_request", "The pending request was not found.");
        }
        const isQuestion = request.kind === "user_input";
        // Tool calls and auth refreshes are answered by the runtime, never by a decision.
        if (!isQuestion && !isApprovalKind(request.kind)) {
          return yield* failure(
            "invalid_request",
            "This request does not take an answer or decision.",
          );
        }
        if (isQuestion ? input.answers === undefined : input.decision === undefined) {
          return yield* failure(
            "invalid_request",
            isQuestion ? "A question needs answers." : "An approval needs a decision.",
          );
        }
        return yield* dispatch({
          type: "runtime-request.respond",
          commandId: yield* commandId(actor, "respond"),
          threadId,
          requestId: input.requestId,
          ...(isQuestion ? { answers: input.answers } : { decision: input.decision }),
        });
      }),
  };

  // Each handler takes its own operation's input; the request union keeps them paired.
  const run = (request: FleetInvokeInput["request"], actor: FleetActor) =>
    (
      handlers[request.op] as (
        input: never,
        actor: FleetActor,
      ) => Effect.Effect<unknown, OrchestratorMcpFailure>
    )(request.input as never, actor);

  return FleetService.of({
    execute: ({ actor, request }) =>
      run(request, actor).pipe(
        Effect.withSpan("FleetService.execute", { attributes: { "fleet.op": request.op } }),
      ),
  });
});

/** Approvals are the provider permission kinds; questions and tool calls are not. */
/** Approval requests take a decision; other provider requests do not. */
const isApprovalKind = Schema.is(ProviderRequestKind);

export const layer = Layer.effect(FleetService, make);
