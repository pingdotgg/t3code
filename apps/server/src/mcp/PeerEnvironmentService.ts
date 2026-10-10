import {
  EnvironmentId,
  MessageId,
  type ModelSelection,
  OrchestratorMcpFailure,
  OrchestratorMcpProviderCapability,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadWaitInput,
  type OrchestratorMcpThreadWaitResult,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  PeerEnvironmentStatus,
  ProjectId,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  DEFAULT_THREAD_ITEM_MAX_CHARS,
  DEFAULT_THREAD_READ_LIMIT,
  DEFAULT_THREAD_RUN_LIMIT,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  providerCapability,
  resolveInteractionMode,
  resolveRuntimeMode,
  threadDetail,
  threadRun,
  timelineItem,
} from "./OrchestratorMcpService.ts";
import * as PeerEnvironmentBroker from "./PeerEnvironmentBroker.ts";
import { newCommandId, readCaller, assertLiveCaller } from "./threadAccess.ts";

export const PeerEnvironmentListResult = Schema.Struct({
  environments: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      /** True for the environment this thread runs in. */
      local: Schema.Boolean,
      status: PeerEnvironmentStatus,
    }),
  ),
  /** Set when other environments could not be looked up at all. */
  unavailableReason: Schema.NullOr(Schema.String),
});
export type PeerEnvironmentListResult = typeof PeerEnvironmentListResult.Type;

export const PeerEnvironmentCatalogResult = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  serverVersion: Schema.String,
  projects: Schema.Array(
    Schema.Struct({ projectId: ProjectId, title: Schema.String, workspaceRoot: Schema.String }),
  ),
  providers: Schema.Array(OrchestratorMcpProviderCapability),
});
export type PeerEnvironmentCatalogResult = typeof PeerEnvironmentCatalogResult.Type;

export interface PeerEnvironmentLaunchInput {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId | undefined;
  readonly title: string;
  readonly modelSelection?: ModelSelection | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly workspaceStrategy?: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
  readonly message?: string | undefined;
}

type Scope = McpInvocationContext.McpInvocationScope;

/**
 * The agent-facing operations on environments other than this one. Every call
 * checks the calling thread here first; the other environment then enforces
 * the permissions of the client session that carries the request.
 */
export class PeerEnvironmentService extends Context.Service<
  PeerEnvironmentService,
  {
    readonly list: (
      scope: Scope,
    ) => Effect.Effect<PeerEnvironmentListResult, OrchestratorMcpFailure>;
    readonly catalog: (
      scope: Scope,
      environmentId: EnvironmentId,
    ) => Effect.Effect<PeerEnvironmentCatalogResult, OrchestratorMcpFailure>;
    readonly launchThread: (
      scope: Scope,
      input: PeerEnvironmentLaunchInput,
    ) => Effect.Effect<
      {
        readonly threadId: ThreadId;
        readonly projectId: ProjectId;
        readonly modelSelection: ModelSelection;
        readonly runId: RunId | null;
        readonly status: OrchestrationV2ThreadProjection["runs"][number]["status"] | null;
      },
      OrchestratorMcpFailure
    >;
    readonly readThread: (
      scope: Scope,
      input: OrchestratorMcpThreadReadInput & { readonly environmentId: EnvironmentId },
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    readonly waitForThread: (
      scope: Scope,
      input: OrchestratorMcpThreadWaitInput & { readonly environmentId: EnvironmentId },
    ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/PeerEnvironmentService") {}

/** Whether a tool's environment selector names somewhere other than this server. */
export const isPeerSelector = (
  scope: Scope,
  environmentId: EnvironmentId | undefined,
): environmentId is EnvironmentId =>
  environmentId !== undefined && environmentId !== scope.environmentId;

const WAIT_POLL_INTERVAL_MS = 2_000;
// Reading a catalog transfers the target's whole project list through the
// carrying client, so a batch of launches validates against one read.
const LAUNCH_CATALOG_TTL_MS = 30_000;
const MESSAGE_VIEW_TYPES = new Set(["user_message", "assistant_message", "proposed_plan"]);

function brokerFailure(error: PeerEnvironmentBroker.PeerEnvironmentBrokerError) {
  switch (error.code) {
    case "host_unavailable":
      return new OrchestratorMcpFailure({
        code: "environment_not_connected",
        message: error.message,
      });
    case "environment_request_failed":
      return new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });
    default:
      return new OrchestratorMcpFailure({ code: error.code, message: error.message });
  }
}

/** Remote launches hand work to another machine, so they need the same caller as local ones. */
function assertLaunchCaller(
  caller: Pick<OrchestrationV2ThreadShell, "runtimeMode" | "interactionMode">,
) {
  return caller.runtimeMode === "full-access" && caller.interactionMode === "default"
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "Launching on another environment requires a full-access/default calling thread.",
        }),
      );
}

/** Rejects ids that belong to a different environment before anything is created there. */
function assertLaunchTarget(
  catalog: PeerEnvironmentCatalogResult,
  target: { readonly projectId: ProjectId; readonly modelSelection: ModelSelection },
) {
  if (!catalog.projects.some((project) => project.projectId === target.projectId)) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Project ${target.projectId} does not exist on ${catalog.label}. Project ids are per-environment; read them with t3_environment_catalog.`,
      }),
    );
  }
  const provider = catalog.providers.find(
    (candidate) => candidate.providerInstanceId === target.modelSelection.instanceId,
  );
  if (provider === undefined) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "provider_unavailable",
        message: `Provider instance ${target.modelSelection.instanceId} does not exist on ${catalog.label}. It has: ${catalog.providers.map((candidate) => candidate.providerInstanceId).join(", ") || "none"}.`,
      }),
    );
  }
  if (provider.constraints.length > 0) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "provider_unavailable",
        message: `Provider instance ${provider.providerInstanceId} on ${catalog.label} cannot run: ${provider.constraints.join(" ")}`,
      }),
    );
  }
  if (
    provider.models.length > 0 &&
    !provider.models.some((model) => model.id === target.modelSelection.model)
  ) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "model_unavailable",
        message: `Model ${target.modelSelection.model} is not offered by ${provider.providerInstanceId} on ${catalog.label}.`,
      }),
    );
  }
  return Effect.void;
}

/** The same page shape as a local read, taken from the window the other environment returned. */
function readProjection(
  projection: OrchestrationV2ThreadProjection,
  input: OrchestratorMcpThreadReadInput,
  nowMs: number,
): OrchestratorMcpThreadReadResult {
  const view = input.view ?? "messages";
  const visible = projection.visibleTurnItems.filter(
    (row) => view === "activity" || MESSAGE_VIEW_TYPES.has(row.item.type),
  );
  const remaining =
    input.itemId === undefined
      ? visible.filter((row) => row.position > (input.afterPosition ?? -1))
      : visible.filter((row) => row.sourceItemId === input.itemId);
  const page = remaining.slice(0, input.limit ?? DEFAULT_THREAD_READ_LIMIT);
  const messagesByThreadId = new Map([[projection.thread.id, projection.messages]]);
  return {
    thread: threadDetail(projection, visible.length, threadShellFromProjection(projection), nowMs),
    recentRuns: projection.runs
      .toSorted((left, right) => right.ordinal - left.ordinal)
      .slice(0, input.runLimit ?? DEFAULT_THREAD_RUN_LIMIT)
      .map(threadRun),
    items: page.map((row) =>
      timelineItem({
        row,
        maxChars: input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS,
        messagesByThreadId,
        ...(input.itemId === undefined ? {} : { textOffset: input.textOffset ?? 0 }),
      }),
    ),
    nextPosition: page.at(-1)?.position ?? null,
    hasMore: page.length < remaining.length,
  };
}

const make = Effect.gen(function* () {
  const broker = yield* PeerEnvironmentBroker.PeerEnvironmentBroker;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;

  const withCaller = <A, E>(
    scope: Scope,
    effect: Effect.Effect<
      A,
      E,
      McpInvocationContext.McpInvocationContext | ThreadManagementService.ThreadManagementService
    >,
  ) =>
    effect.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    );

  const loadCatalog = (environmentId: EnvironmentId) =>
    broker.invoke({ operation: "catalog", environmentId }).pipe(
      Effect.mapError(brokerFailure),
      Effect.map((result): PeerEnvironmentCatalogResult => ({
        environmentId,
        label: result.label,
        serverVersion: result.serverVersion,
        projects: result.projects.map((project) => ({
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        })),
        // Whether an adapter is registered is only known over there; the
        // provider's own status already reports whether it can run.
        providers: result.providers.map((provider) => providerCapability(provider, true)),
      })),
    );

  const catalogs = yield* Ref.make(
    new Map<
      EnvironmentId,
      { readonly at: number; readonly catalog: PeerEnvironmentCatalogResult }
    >(),
  );
  const refreshCatalog = Effect.fn("PeerEnvironmentService.refreshCatalog")(function* (
    environmentId: EnvironmentId,
  ) {
    const catalog = yield* loadCatalog(environmentId);
    const at = yield* Clock.currentTimeMillis;
    yield* Ref.update(catalogs, (current) => new Map(current).set(environmentId, { at, catalog }));
    return catalog;
  });
  const recentCatalog = Effect.fn("PeerEnvironmentService.recentCatalog")(function* (
    environmentId: EnvironmentId,
  ) {
    const known = (yield* Ref.get(catalogs)).get(environmentId);
    const now = yield* Clock.currentTimeMillis;
    return known !== undefined && now - known.at < LAUNCH_CATALOG_TTL_MS
      ? known.catalog
      : yield* refreshCatalog(environmentId);
  });

  const loadProjection = (environmentId: EnvironmentId, threadId: ThreadId) =>
    broker.invoke({ operation: "thread_projection", environmentId, threadId }).pipe(
      Effect.mapError(brokerFailure),
      Effect.map((result) => result.projection),
    );

  return PeerEnvironmentService.of({
    list: Effect.fn("PeerEnvironmentService.list")(function* (scope) {
      yield* withCaller(scope, readCaller());
      const descriptor = yield* environment.getDescriptor;
      const local = {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        local: true,
        status: "connected" as const,
      };
      return yield* broker.list.pipe(
        Effect.map((peers) => ({
          environments: [
            local,
            ...peers
              .filter((peer) => peer.environmentId !== descriptor.environmentId)
              .map((peer) => ({ ...peer, local: false })),
          ],
          unavailableReason: null,
        })),
        Effect.catch((error) =>
          Effect.succeed({ environments: [local], unavailableReason: error.message }),
        ),
      );
    }),
    catalog: Effect.fn("PeerEnvironmentService.catalog")(function* (scope, environmentId) {
      yield* withCaller(scope, readCaller());
      return yield* refreshCatalog(environmentId);
    }),
    launchThread: Effect.fn("PeerEnvironmentService.launchThread")(function* (scope, input) {
      const { limits } = yield* withCaller(scope, readCaller().pipe(Effect.tap(assertLiveCaller)));
      yield* assertLaunchCaller(limits);
      if (input.projectId === undefined || input.modelSelection === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "projectId and modelSelection are required with environmentId: nothing is inherited across environments. Read the target's ids with t3_environment_catalog.",
        });
      }
      const target = { projectId: input.projectId, modelSelection: input.modelSelection };
      const runtimeMode = yield* resolveRuntimeMode(limits.runtimeMode, input.runtimeMode);
      const interactionMode = yield* resolveInteractionMode(
        limits.interactionMode,
        input.interactionMode,
      );
      yield* assertLaunchTarget(yield* recentCatalog(input.environmentId), target);
      const commandId = yield* newCommandId().pipe(Effect.provideService(Crypto.Crypto, crypto));
      const messageId = MessageId.make(commandId);
      const launched = yield* broker
        .invoke(
          {
            operation: "launch",
            environmentId: input.environmentId,
            input: {
              commandId,
              threadId: ThreadId.make(commandId),
              creationSource: "mcp",
              ...target,
              title: input.title,
              runtimeMode,
              interactionMode,
              workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
              ...(input.message === undefined
                ? {}
                : { initialMessage: { messageId, text: input.message, attachments: [] } }),
            },
          },
          // Covers a slow launch acknowledgement, not workspace preparation,
          // which continues after the thread exists.
          60_000,
        )
        .pipe(Effect.mapError(brokerFailure));
      const { thread, runs } = launched.result.projection;
      const run = runs.find((candidate) => candidate.userMessageId === messageId);
      return {
        threadId: thread.id,
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        runId: run?.id ?? null,
        status: run?.status ?? null,
      };
    }),
    readThread: Effect.fn("PeerEnvironmentService.readThread")(function* (scope, input) {
      yield* withCaller(scope, readCaller());
      return readProjection(yield* loadProjection(input.environmentId, input.threadId), input, yield* Clock.currentTimeMillis);
    }),
    waitForThread: Effect.fn("PeerEnvironmentService.waitForThread")(function* (scope, input) {
      yield* withCaller(scope, readCaller());
      const timeoutMs = Math.min(
        MAX_WAIT_TIMEOUT_MS,
        Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
      );
      const first = yield* loadProjection(input.environmentId, input.threadId);
      const runId = input.runId ?? ThreadManagementService.latestRun(first)?.id;
      if (runId === undefined) {
        return { threadId: input.threadId, runId: null, status: "idle" as const, timedOut: false };
      }
      const findRun = (
        projection: OrchestrationV2ThreadProjection,
      ): Effect.Effect<OrchestrationV2ThreadProjection["runs"][number], OrchestratorMcpFailure> => {
        const run = projection.runs.find((candidate) => candidate.id === runId);
        return run === undefined
          ? Effect.fail(
              new OrchestratorMcpFailure({
                code: "run_not_found",
                message: `Run ${runId} was not found in thread ${input.threadId}.`,
              }),
            )
          : Effect.succeed(run);
      };
      // The other environment cannot push to this server, so its state is
      // re-read through the carrying client until the run settles.
      let latest = yield* findRun(first);
      const settled = (
        projection: OrchestrationV2ThreadProjection,
      ): Effect.Effect<void, OrchestratorMcpFailure> =>
        findRun(projection).pipe(
          Effect.flatMap((run) => {
            latest = run;
            return ThreadManagementService.isTerminalRunStatus(run.status)
              ? Effect.void
              : Effect.sleep(WAIT_POLL_INTERVAL_MS).pipe(
                  Effect.andThen(loadProjection(input.environmentId, input.threadId)),
                  Effect.flatMap(settled),
                );
          }),
        );
      const finished = yield* settled(first).pipe(Effect.timeoutOption(timeoutMs));
      return {
        threadId: input.threadId,
        runId,
        status: latest.status,
        timedOut: finished._tag === "None",
      };
    }),
  });
});

export const layer = Layer.effect(PeerEnvironmentService, make);
