import { performAgentHandoff } from "./handoff.ts";
import {
  ApprovalRequestId,
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  McpGatewayProfile,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { hasQueuedTurnStart } from "../state/threadSettled.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  controlThreadLifecycle,
  createThread,
  respondToThreadApproval,
  respondToThreadApprovals,
  startThreadTurn,
  settleThread,
  unsettleThread,
} from "../operations/commands.ts";
import { request, runStream, subscribe } from "../rpc/client.ts";
import type {
  GatewayProfile,
  GatewayProfileModelSelection,
  GatewayRuntimeEvent,
  GatewayRuntimeEventSource,
  GatewayRuntimePort,
} from "./port.ts";

export interface GatewayEffectRuntime {
  runPromise<A, E>(effect: Effect.Effect<A, E, EnvironmentRegistry | Crypto.Crypto>): Promise<A>;
}

export function createGatewayRuntimePortFromContext(
  context: Context.Context<EnvironmentRegistry | Crypto.Crypto>,
  openThread?: (environmentId: string, threadId: string) => Promise<void>,
  openAgents?: () => Promise<void>,
): GatewayRuntimePort {
  return createGatewayRuntimePort(
    {
      runPromise: (effect) => Effect.runPromiseWith(context)(effect),
    },
    openThread,
    openAgents,
  );
}

function targetKind(tag: string): string {
  return tag.replace(/ConnectionTarget$/, "").toLowerCase();
}

const shellSnapshot = (environmentId: EnvironmentId) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    return yield* registry
      .run(
        environmentId,
        subscribe(ORCHESTRATION_WS_METHODS.subscribeShell, {}).pipe(
          Stream.filter((item) => item.kind === "snapshot"),
          Stream.runHead,
          Effect.map(
            (item) =>
              (Option.getOrThrow(item) as { snapshot: OrchestrationShellSnapshot }).snapshot,
          ),
        ),
      )
      .pipe(Effect.timeout("20 seconds"));
  });

const threadSnapshot = (environmentId: EnvironmentId, threadId: ThreadId, turnLimit?: number) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    return yield* registry
      .run(
        environmentId,
        subscribe(ORCHESTRATION_WS_METHODS.subscribeThread, {
          threadId,
          ...(turnLimit === undefined ? {} : { turnLimit }),
        }).pipe(
          Stream.filter((item) => item.kind === "snapshot"),
          Stream.runHead,
          Effect.map(
            (item) =>
              (Option.getOrThrow(item) as { snapshot: OrchestrationThreadDetailSnapshot }).snapshot,
          ),
        ),
      )
      .pipe(Effect.timeout("20 seconds"));
  });

/**
 * Resolves persisted readable profile labels against a live provider catalog.
 * Exactly one enabled/available provider + model pair must match; duplicate
 * labels stay unresolved rather than routing a thread ambiguously. Legacy
 * profiles without labels validate their persisted routing snapshot against
 * the same live catalog.
 */
export function resolveGatewayProfileModelSelection(
  profile: Pick<GatewayProfile, "providerLabel" | "modelLabel" | "modelSelection">,
  providers: ReadonlyArray<ServerProvider>,
): GatewayProfileModelSelection | undefined {
  if (profile.providerLabel === undefined || profile.modelLabel === undefined) {
    const selection = profile.modelSelection;
    if (selection === undefined) return undefined;
    const matches = providers.filter(
      (provider) =>
        provider.instanceId === selection.instanceId &&
        provider.enabled &&
        provider.status === "ready" &&
        provider.availability !== "unavailable" &&
        provider.models.some((model) => model.slug === selection.model),
    );
    return matches.length === 1 ? selection : undefined;
  }
  const matches = providers.flatMap((provider) => {
    const providerLabel = provider.displayName?.trim() || provider.driver;
    if (
      !provider.enabled ||
      provider.status !== "ready" ||
      provider.availability === "unavailable" ||
      providerLabel !== profile.providerLabel
    ) {
      return [];
    }
    return provider.models
      .filter((model) => model.slug === profile.modelLabel || model.name === profile.modelLabel)
      .map((model) => ({ instanceId: provider.instanceId, model: model.slug }));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function approvalResponsesFromModifications(modifications: unknown): ReadonlyArray<{
  readonly approvalRequestId: string;
  readonly decision: "accept" | "acceptForSession" | "decline" | "cancel";
}> {
  if (!Array.isArray(modifications) || modifications.length === 0) {
    throw new Error("Invalid approval modification: modifications must be non-empty.");
  }
  return modifications.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("Invalid approval modification: expected an action object.");
    }
    const modification = candidate as Record<string, unknown>;
    const fields = modification.fields;
    const decision =
      typeof fields === "object" && fields !== null && !Array.isArray(fields)
        ? (fields as Record<string, unknown>).decision
        : undefined;
    if (
      typeof modification.actionId !== "string" ||
      (decision !== "accept" &&
        decision !== "acceptForSession" &&
        decision !== "decline" &&
        decision !== "cancel")
    ) {
      throw new Error("Invalid approval modification: actionId and decision are required.");
    }
    return { approvalRequestId: modification.actionId, decision };
  });
}

interface GatewayEventContext {
  readonly machine: string;
  readonly project?: { readonly id: string; readonly title: string };
  readonly thread?: { readonly title: string; readonly status: string };
}

function boundedText(value: unknown, limit = 512): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim().slice(0, limit)
    : undefined;
}

function boundedRecordField(
  record: Readonly<Record<string, unknown>>,
  key: string,
  maxLength = 2_000,
): Readonly<Record<string, string>> {
  const value = boundedText(record[key], maxLength);
  return value === undefined ? {} : { [key]: value };
}

function gatewayStatusForActivity(kind: string | undefined, fallback: string | undefined) {
  // Lifecycle receipts acknowledge provider requests; they do not prove that
  // the active turn has ended. Prefer the projected session/turn snapshot.
  if (kind === "approval.requested") return "waiting-approval";
  if (kind === "user-input.requested") return "waiting-input";
  if (fallback !== undefined) return fallback;
  if (kind === "turn.completed") return "completed";
  if (kind === "turn.failed" || kind === "error") return "failed";
  if (kind === "turn.interrupted") return "interrupted";
  return undefined;
}

function gatewayNextAction(status: string | undefined): string | null | undefined {
  if (status === "waiting-approval") return "approve_actions";
  if (status === "waiting-input") return "provide_input";
  if (status === "paused") return "resume";
  if (status === "stopped") return "restart";
  if (status === "running" || status === "queued") return "await_event";
  if (status === "failed" || status === "interrupted") return "retry_or_restart";
  if (status === "completed" || status === "canceled") return null;
  return undefined;
}

export function gatewayEventFromOrchestration(
  environmentId: EnvironmentId,
  event: OrchestrationEvent,
  context?: GatewayEventContext,
): GatewayRuntimeEvent {
  const payload = event.payload as unknown as Record<string, unknown>;
  const activity =
    event.type === "thread.activity-appended" &&
    typeof payload.activity === "object" &&
    payload.activity !== null
      ? (payload.activity as Record<string, unknown>)
      : undefined;
  const activityPayload =
    typeof activity?.payload === "object" && activity.payload !== null
      ? (activity.payload as Record<string, unknown>)
      : undefined;
  const activityKind = boundedText(activity?.kind, 128);
  const status = gatewayStatusForActivity(activityKind, context?.thread?.status);
  const type =
    event.type === "thread.created" || event.type === "thread.turn-start-requested"
      ? "thread.started"
      : event.type === "thread.session-set"
        ? "thread.state_changed"
        : activityKind === "approval.requested"
          ? "approval.requested"
          : activityKind === "user-input.requested"
            ? "input.requested"
            : activityKind === "turn.completed"
              ? "thread.completed"
              : activityKind === "turn.failed" || activityKind === "error"
                ? "thread.failed"
                : activityKind === "turn.interrupted"
                  ? "thread.interrupted"
                  : activityKind === "artifact.created" || activityKind === "artifact.updated"
                    ? activityKind
                    : activityKind === "pr.updated" || activityKind === "milestone"
                      ? activityKind === "milestone"
                        ? "thread.milestone"
                        : activityKind
                      : activityKind === "blocked" || activityKind === "turn.blocked"
                        ? "thread.blocked"
                        : event.aggregateKind === "thread"
                          ? "thread.progress"
                          : event.type;
  const requestId = boundedText(activityPayload?.requestId, 256);
  const summary = boundedText(activity?.summary);
  const nextAction = gatewayNextAction(status);
  const projectId = boundedText(payload.projectId, 256) ?? context?.project?.id;
  const threadTitle = boundedText(payload.title) ?? context?.thread?.title;
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    environmentId,
    type,
    ...(event.aggregateKind === "thread" ? { threadId: event.aggregateId } : {}),
    ...(event.correlationId === null ? {} : { correlationId: event.correlationId }),
    data: {
      ...(context?.machine === undefined ? {} : { machine: context.machine }),
      ...(projectId === undefined
        ? {}
        : {
            project: {
              id: projectId,
              ...(context?.project?.title === undefined ? {} : { title: context.project.title }),
            },
          }),
      ...(threadTitle === undefined ? {} : { threadTitle }),
      ...(status === undefined ? {} : { status }),
      ...(summary === undefined ? {} : { summary }),
      ...(nextAction === undefined ? {} : { nextAction }),
      ...(activityKind === "approval.requested" || activityKind === "user-input.requested"
        ? {
            blocker: {
              kind: activityKind === "approval.requested" ? "approval" : "input",
              ...(requestId === undefined ? {} : { requestId }),
            },
          }
        : {}),
      serverSequence: event.sequence,
      serverEventType: event.type,
      ...(activityKind === undefined ? {} : { activityKind }),
      ...(requestId === undefined ? {} : { requestId }),
    },
  };
}

function isSafeWorkspaceRelativePath(path: string): boolean {
  return (
    !path.startsWith("/") &&
    !path.startsWith("\\") &&
    !/^[a-z]:[\\/]/i.test(path) &&
    path.split(/[\\/]/).every((segment) => segment !== "..")
  );
}

function gatewayProjectProjection(project: OrchestrationShellSnapshot["projects"][number]) {
  return {
    id: project.id,
    title: project.title,
    defaultModelSelection: project.defaultModelSelection,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function gatewayThreadShellProjection(thread: OrchestrationShellSnapshot["threads"][number]) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    profileSnapshot: thread.profileSnapshot,
    settledAt: thread.settledAt,
    title: thread.title,
    status: gatewayStatusFromThread(thread),
    latestTurn: thread.latestTurn,
    session:
      thread.session === null
        ? null
        : {
            status: thread.session.status,
            runtimeMode: thread.session.runtimeMode,
            activeTurnId: thread.session.activeTurnId,
            updatedAt: thread.session.updatedAt,
          },
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function gatewayArtifactsFromThread(thread: OrchestrationThreadDetailSnapshot["thread"]) {
  return (thread.artifacts ?? []).slice(-2_000).flatMap((artifact) => {
    if (artifact.kind === "workspace-file") {
      if (artifact.path === undefined || !isSafeWorkspaceRelativePath(artifact.path)) return [];
      return [{ ...artifact, name: boundedText(artifact.name, 512) ?? "artifact" }];
    }
    return [
      {
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        sourceId: artifact.sourceId,
        name: boundedText(artifact.name, 512) ?? "artifact",
        ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType }),
        ...(artifact.sizeBytes === undefined ? {} : { sizeBytes: artifact.sizeBytes }),
        availability: artifact.availability,
        createdAt: artifact.createdAt,
      },
    ];
  });
}

function gatewayActivity(
  activity: OrchestrationThreadDetailSnapshot["thread"]["activities"][number],
) {
  const payload = activity.payload as Readonly<Record<string, unknown>>;
  const safePayload = {
    ...boundedRecordField(payload, "requestId", 256),
    ...boundedRecordField(payload, "requestKind", 128),
    ...boundedRecordField(payload, "action", 64),
    ...boundedRecordField(payload, "attemptId", 256),
    ...boundedRecordField(payload, "status", 64),
  };
  return {
    id: activity.id,
    sequence: activity.sequence,
    turnId: activity.turnId,
    tone: activity.tone,
    kind: activity.kind,
    summary: boundedText(activity.summary, 2_000) ?? "Activity",
    payload: safePayload,
    createdAt: activity.createdAt,
  };
}

const decodeProfile = Schema.decodeUnknownSync(McpGatewayProfile);
const decodeProfiles = Schema.decodeUnknownEffect(Schema.Array(McpGatewayProfile));

export function gatewayThreadProjection(thread: OrchestrationThreadDetailSnapshot["thread"]) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    status: gatewayStatusFromThread({
      latestTurn: thread.latestTurn,
      session: thread.session,
      latestUserMessageAt:
        thread.messages.findLast((message) => message.role === "user")?.createdAt ?? null,
    }),
    modelSelection: thread.modelSelection,
    profileSnapshot: thread.profileSnapshot,
    settledAt: thread.settledAt,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    latestTurn: thread.latestTurn,
    session:
      thread.session === null
        ? null
        : {
            status: thread.session.status,
            runtimeMode: thread.session.runtimeMode,
            activeTurnId: thread.session.activeTurnId,
            updatedAt: thread.session.updatedAt,
          },
    messages: thread.messages.slice(-500).map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text.slice(0, 120_000),
      attachments: (message.attachments ?? []).slice(0, 100).map((attachment) => ({
        type: attachment.type,
        id: boundedText(attachment.id, 512) ?? "attachment",
        name: boundedText(attachment.name, 512) ?? "attachment",
        mimeType: boundedText(attachment.mimeType, 255) ?? "application/octet-stream",
        sizeBytes: attachment.sizeBytes,
      })),
      turnId: message.turnId,
      streaming: message.streaming,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })),
    activities: thread.activities.slice(-1_000).map(gatewayActivity),
    artifacts: gatewayArtifactsFromThread(thread),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

export function gatewayStatusFromThread(
  thread: Pick<
    OrchestrationShellSnapshot["threads"][number],
    "latestTurn" | "session" | "latestUserMessageAt"
  >,
  now = DateTime.formatIso(DateTime.nowUnsafe()),
): string {
  if (thread.session?.status === "running" || thread.session?.status === "starting")
    return "running";
  if (hasQueuedTurnStart(thread, { now })) return "queued";
  if (thread.session?.status === "stopped") return "stopped";
  if (thread.session?.status === "error") return "failed";
  if (thread.session?.status === "interrupted") return "interrupted";
  if (thread.latestTurn?.state === "running") return "running";
  if (thread.latestTurn?.state === "completed") return "completed";
  if (thread.latestTurn?.state === "error") return "failed";
  if (thread.latestTurn?.state === "interrupted") return "interrupted";
  return "idle";
}

function gatewayEventContext(
  machine: string,
  snapshot: OrchestrationShellSnapshot,
  event: OrchestrationEvent,
): GatewayEventContext {
  const thread =
    event.aggregateKind === "thread"
      ? snapshot.threads.find((candidate) => candidate.id === event.aggregateId)
      : undefined;
  const payload = event.payload as unknown as Record<string, unknown>;
  const projectId = typeof payload.projectId === "string" ? payload.projectId : thread?.projectId;
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  return {
    machine,
    ...(project === undefined ? {} : { project: { id: project.id, title: project.title } }),
    ...(thread === undefined
      ? {}
      : { thread: { title: thread.title, status: gatewayStatusFromThread(thread) } }),
  };
}

export function enrichGatewayRuntimeEventStream<E, R, E2, R2>(input: {
  readonly environmentId: EnvironmentId;
  readonly machine: string;
  readonly initialSnapshot: OrchestrationShellSnapshot;
  readonly events: Stream.Stream<OrchestrationEvent, E, R>;
  readonly loadSnapshot: (
    event: OrchestrationEvent,
  ) => Effect.Effect<OrchestrationShellSnapshot, E2, R2>;
}): Stream.Stream<GatewayRuntimeEvent, E | E2, R | R2> {
  return Stream.suspend(() => {
    let latestSnapshot = input.initialSnapshot;
    return input.events.pipe(
      Stream.mapEffect((event) =>
        (latestSnapshot.snapshotSequence >= event.sequence
          ? Effect.succeed(latestSnapshot)
          : input.loadSnapshot(event)
        ).pipe(
          Effect.map((snapshot) => {
            latestSnapshot = snapshot;
            return gatewayEventFromOrchestration(
              input.environmentId,
              event,
              gatewayEventContext(input.machine, snapshot, event),
            );
          }),
        ),
      ),
    );
  });
}

export function createGatewayRuntimeEventSourceFromContext(
  context: Context.Context<EnvironmentRegistry | Crypto.Crypto>,
): GatewayRuntimeEventSource {
  return {
    subscribe: (listener, subscription) => {
      const allowedEnvironmentIds = new Set(subscription.environmentIds);
      const stream = Stream.unwrap(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          return Stream.concat(
            Stream.fromEffect(SubscriptionRef.get(registry.entries)),
            SubscriptionRef.changes(registry.entries),
          ).pipe(
            Stream.switchMap((entries) =>
              Stream.mergeAll(
                [...entries.values()]
                  .filter((entry) => allowedEnvironmentIds.has(entry.target.environmentId))
                  .map((entry) => {
                    const environmentId = entry.target.environmentId;
                    return Stream.unwrap(
                      shellSnapshot(environmentId).pipe(
                        Effect.map((snapshot) =>
                          enrichGatewayRuntimeEventStream({
                            environmentId,
                            machine: entry.target.label,
                            initialSnapshot: snapshot,
                            events: registry.runStream(
                              environmentId,
                              subscribe(ORCHESTRATION_WS_METHODS.subscribeEvents, {
                                afterSequence:
                                  subscription.afterSequenceByEnvironment[environmentId] ?? 0,
                              }),
                            ),
                            loadSnapshot: () => shellSnapshot(environmentId),
                          }),
                        ),
                      ),
                    ).pipe(Stream.catchCause(() => Stream.empty));
                  }),
                { concurrency: "unbounded" },
              ),
            ),
          );
        }),
      );
      const fiber = Effect.runForkWith(context)(
        Stream.runForEach(stream, (event) => Effect.sync(() => listener(event))),
      );
      return () => fiber.interruptUnsafe();
    },
  };
}

export function createGatewayRuntimePort(
  runtime: GatewayEffectRuntime,
  openThread?: (environmentId: string, threadId: string) => Promise<void>,
  openAgents?: () => Promise<void>,
): GatewayRuntimePort {
  const run = <A, E>(effect: Effect.Effect<A, E, EnvironmentRegistry | Crypto.Crypto>) =>
    runtime.runPromise(effect);

  // Serialize profile read/modify/write operations issued by this host.
  let profileQueue: Promise<unknown> = Promise.resolve();
  const mutateProfiles = (
    rawEnvironmentId: string,
    mutate: (profiles: ReadonlyArray<McpGatewayProfile>) => ReadonlyArray<McpGatewayProfile>,
  ) => {
    const operation = profileQueue.then(() =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const environmentId = EnvironmentId.make(rawEnvironmentId);
          const settings = yield* registry.run(
            environmentId,
            request(WS_METHODS.serverGetSettings, {}),
          );
          return yield* registry.run(
            environmentId,
            request(WS_METHODS.serverUpdateSettings, {
              patch: { mcpGatewayProfiles: mutate(settings.mcpGatewayProfiles) },
            }),
          );
        }),
      ),
    );
    profileQueue = operation.catch(() => undefined);
    return operation;
  };
  const port: GatewayRuntimePort = {
    unsettleThread: (environmentId, threadId) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const crypto = yield* Crypto.Crypto;
          yield* registry.run(
            EnvironmentId.make(environmentId),
            unsettleThread({
              threadId: ThreadId.make(threadId),
              reason: "user",
              commandId: CommandId.make(yield* crypto.randomUUIDv4),
            }),
          );
          return { status: "succeeded" as const };
        }),
      ),
    settleThread: (environmentId, threadId) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const crypto = yield* Crypto.Crypto;
          yield* registry.run(
            EnvironmentId.make(environmentId),
            settleThread({
              threadId: ThreadId.make(threadId),
              commandId: CommandId.make(yield* crypto.randomUUIDv4),
            }),
          );
          return { status: "succeeded" as const };
        }),
      ),
    handoffThread: async (input) => {
      const source = await run(shellSnapshot(EnvironmentId.make(input.sourceEnvironmentId)));
      const thread = source.threads.find((t) => t.id === input.sourceThreadId);
      const project = source.projects.find((p) => p.id === thread?.projectId);
      if (!thread || !project) throw new Error("Source thread or project is unavailable.");
      const target = await run(shellSnapshot(EnvironmentId.make(input.environmentId)));
      const targetProject = target.projects.find((p) => p.id === input.projectId);
      if (!targetProject) throw new Error("Destination project is unavailable.");
      return performAgentHandoff(port, input, {
        readSource: (path) =>
          run(
            Effect.gen(function* () {
              const registry = yield* EnvironmentRegistry;
              return yield* registry.run(
                EnvironmentId.make(input.sourceEnvironmentId),
                request(WS_METHODS.projectsReadFile, {
                  cwd: thread.worktreePath ?? project.workspaceRoot,
                  relativePath: path,
                }),
              );
            }),
          ),
        writeBrief: (path, contents) =>
          run(
            Effect.gen(function* () {
              const registry = yield* EnvironmentRegistry;
              yield* registry.run(
                EnvironmentId.make(input.environmentId),
                request(WS_METHODS.projectsWriteFile, {
                  cwd: targetProject.workspaceRoot,
                  relativePath: path,
                  contents,
                }),
              );
            }),
          ),
      });
    },
    openAgents: async () => {
      if (!openAgents) throw new Error("Desktop agents navigation is unavailable in this runtime.");
      await openAgents();
      return { status: "succeeded" };
    },
    createProfile: async (environmentId, input) => {
      const profileId = await run(
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          return yield* crypto.randomUUIDv4;
        }),
      );
      const now = await run(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
      const profile = decodeProfile({
        ...input,
        profileId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      const settings = await mutateProfiles(environmentId, (profiles) => [...profiles, profile]);
      return settings.mcpGatewayProfiles.find((item) => item.profileId === profileId)!;
    },
    updateProfile: async (environmentId, profileId, patch) => {
      const settings = await mutateProfiles(environmentId, (profiles) => {
        if (!profiles.some((profile) => profile.profileId === profileId))
          throw new Error(`Agent ${profileId} was not found.`);
        return profiles.map((profile) =>
          profile.profileId === profileId
            ? decodeProfile({
                ...profile,
                ...patch,
                ...(patch.providerLabel !== undefined || patch.modelLabel !== undefined
                  ? { modelSelection: undefined }
                  : {}),
              })
            : profile,
        );
      });
      return settings.mcpGatewayProfiles.find((profile) => profile.profileId === profileId)!;
    },
    deleteProfile: async (environmentId, profileId) => {
      const settings = await mutateProfiles(environmentId, (profiles) =>
        profiles.filter((profile) => profile.profileId !== profileId),
      );
      return {
        profileId,
        status: "succeeded",
        deletedAt: settings.mcpGatewayProfileDeletedAt[profileId],
      };
    },
    replicateProfiles: async (environmentId, profiles, deletedAt) => {
      await run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            EnvironmentId.make(environmentId),
            request(WS_METHODS.serverUpdateSettings, {
              patch: {
                mcpGatewayProfiles: yield* decodeProfiles(profiles),
                ...(deletedAt ? { mcpGatewayProfileDeletedAt: deletedAt } : {}),
              },
              replicateProfiles: true,
            }),
          );
        }),
      );
    },
    openThread: async (environmentId, threadId) => {
      if (!openThread) throw new Error("Desktop chat navigation is unavailable in this runtime.");
      const snapshot = await run(
        threadSnapshot(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
      );
      if (snapshot.thread.id !== threadId || snapshot.thread.deletedAt !== null) {
        throw new Error(`Thread ${threadId} was not found.`);
      }
      await openThread(environmentId, threadId);
      return { environmentId, threadId, status: "succeeded" };
    },
    listEnvironments: () =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const entries = yield* SubscriptionRef.get(registry.entries);
          return yield* Effect.forEach([...entries.values()], (entry) =>
            registry.state(entry.target.environmentId).pipe(
              Effect.map((state) => ({
                environmentId: entry.target.environmentId,
                label: entry.target.label,
                targetKind: targetKind(entry.target._tag),
                connectionState: state.phase,
              })),
            ),
          );
        }),
      ),
    getEnvironmentStatus: (rawEnvironmentId) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const environmentId = EnvironmentId.make(rawEnvironmentId);
          const state = yield* registry.state(environmentId);
          return { environmentId, ...state } as Record<string, unknown>;
        }),
      ),
    listProfiles: (rawEnvironmentId) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const settings = yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.serverGetSettings, {}),
          );
          return settings.mcpGatewayProfiles.map((profile) => ({
            ...profile,
            modelSelection: profile.modelSelection as GatewayProfileModelSelection | undefined,
          }));
        }),
      ),
    resolveProfileModelSelection: (rawEnvironmentId, profile) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const config = yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.serverGetConfig, {}),
          );
          return resolveGatewayProfileModelSelection(profile, config.providers);
        }),
      ),
    listProjects: (rawEnvironmentId) =>
      run(shellSnapshot(EnvironmentId.make(rawEnvironmentId))).then((snapshot) => ({
        items: snapshot.projects.map(gatewayProjectProjection),
        snapshotAt: snapshot.updatedAt,
      })),
    listThreads: (rawEnvironmentId) =>
      run(shellSnapshot(EnvironmentId.make(rawEnvironmentId))).then((snapshot) => ({
        items: snapshot.threads.map(gatewayThreadShellProjection),
        snapshotAt: snapshot.updatedAt,
      })),
    getThread: (rawEnvironmentId, rawThreadId) =>
      run(
        threadSnapshot(EnvironmentId.make(rawEnvironmentId), ThreadId.make(rawThreadId), 100),
      ).then((snapshot) => gatewayThreadProjection(snapshot.thread)),
    hasThreadMessage: (rawEnvironmentId, rawThreadId, rawMessageId) =>
      run(threadSnapshot(EnvironmentId.make(rawEnvironmentId), ThreadId.make(rawThreadId))).then(
        (snapshot) => snapshot.thread.messages.some((message) => message.id === rawMessageId),
      ),
    createAssetUrl: (rawEnvironmentId, resource) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const typedResource =
            resource._tag === "attachment"
              ? resource
              : { ...resource, threadId: ThreadId.make(resource.threadId) };
          const asset = yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.assetsCreateUrl, { resource: typedResource }),
          );
          return { relativeUrl: asset.relativeUrl, expiresAt: asset.expiresAt };
        }),
      ),
    getPullRequest: (rawEnvironmentId, ref) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          return (yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.pullRequestsDetail, {
              ...ref,
              projectId: ProjectId.make(ref.projectId),
            }),
          )) as Record<string, unknown>;
        }),
      ),
    getPullRequestActivity: (rawEnvironmentId, ref) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          return (yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(WS_METHODS.pullRequestsActivity, {
              ...ref,
              projectId: ProjectId.make(ref.projectId),
            }),
          )) as Record<string, unknown>;
        }),
      ),
    getCommandReceipts: (rawEnvironmentId, commandIds) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const result = yield* registry.run(
            EnvironmentId.make(rawEnvironmentId),
            request(ORCHESTRATION_WS_METHODS.getCommandReceipts, {
              commandIds: commandIds.map((commandId) => CommandId.make(commandId)),
            }),
          );
          return result.receipts;
        }),
      ),
    createThread: (input) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            EnvironmentId.make(input.environmentId),
            createThread({
              commandId: CommandId.make(input.requestId),
              threadId: ThreadId.make(input.threadId),
              projectId: ProjectId.make(input.projectId),
              title: input.title,
              ...(input.modelSelection === undefined
                ? { useServerDefaults: input.profileSelection === undefined }
                : {
                    modelSelection: {
                      ...input.modelSelection,
                      instanceId: ProviderInstanceId.make(input.modelSelection.instanceId),
                    },
                  }),
              ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
              ...(input.interactionMode === undefined
                ? {}
                : { interactionMode: input.interactionMode }),
              ...(input.profileSelection === undefined
                ? {}
                : { profileSelection: input.profileSelection }),
              branch: null,
              worktreePath: null,
            }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
          };
        }),
      ),
    sendMessage: (input) =>
      run(
        Effect.gen(function* () {
          const environmentId = EnvironmentId.make(input.environmentId);
          const threadId = ThreadId.make(input.threadId);
          const shell = yield* shellSnapshot(environmentId);
          const thread = shell.threads.find((candidate) => candidate.id === threadId);
          if (thread === undefined) throw new Error(`Thread ${input.threadId} was not found.`);
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            environmentId,
            startThreadTurn({
              commandId: CommandId.make(input.requestId),
              threadId,
              message: {
                messageId: MessageId.make(input.messageId),
                role: "user",
                text: input.text,
                attachments: [],
              },
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
            }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
            messageId: input.messageId,
          };
        }),
      ),
    controlThread: (input) =>
      run(
        Effect.gen(function* () {
          const environmentId = EnvironmentId.make(input.environmentId);
          const threadId = ThreadId.make(input.threadId);
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            environmentId,
            controlThreadLifecycle({
              commandId: CommandId.make(input.requestId),
              threadId,
              action: input.action,
              attemptId: input.requestId,
              messageId: MessageId.make(input.messageId),
            }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
          };
        }),
      ),
    respondToApprovals: (input) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            EnvironmentId.make(input.environmentId),
            respondToThreadApprovals({
              commandId: CommandId.make(input.requestId),
              threadId: ThreadId.make(input.threadId),
              expectedRevision: input.expectedRevision,
              responses: input.responses.map((response) => ({
                requestId: ApprovalRequestId.make(response.approvalRequestId),
                decision: response.decision,
              })),
            }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
          };
        }),
      ),
    respondToApproval: (input) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          yield* registry.run(
            EnvironmentId.make(input.environmentId),
            respondToThreadApproval({
              commandId: CommandId.make(input.requestId),
              threadId: ThreadId.make(input.threadId),
              requestId: ApprovalRequestId.make(input.approvalRequestId),
              decision: input.decision,
            }),
          );
          return {
            requestId: input.requestId,
            commandId: input.requestId,
            status: "accepted" as const,
            threadId: input.threadId,
          };
        }),
      ),
    executeOperation: (input) =>
      run(
        Effect.gen(function* () {
          const registry = yield* EnvironmentRegistry;
          const environmentId = EnvironmentId.make(input.environmentId);
          const payload = input.payload;
          const projectId =
            typeof payload.projectId === "string" ? ProjectId.make(payload.projectId) : undefined;
          const project =
            projectId === undefined
              ? undefined
              : (yield* shellSnapshot(environmentId)).projects.find(
                  (candidate) => candidate.id === projectId,
                );
          const cwd = project?.workspaceRoot;
          if (input.operation === "approval.modify") {
            const threadId = ThreadId.make(String(payload.threadId ?? ""));
            const expectedRevision = Number(payload.planRevision);
            if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
              throw new Error("Invalid approval plan revision.");
            }
            const responses = approvalResponsesFromModifications(payload.modifications);
            yield* registry.run(
              environmentId,
              respondToThreadApprovals({
                commandId: CommandId.make(input.requestId ?? `gateway-approval-modify:${threadId}`),
                threadId,
                expectedRevision,
                responses: responses.map((response) => ({
                  requestId: ApprovalRequestId.make(response.approvalRequestId),
                  decision: response.decision,
                })),
              }),
            );
            return {
              accepted: true,
              threadId,
              expectedRevision,
              modifiedCount: responses.length,
            };
          }
          if (input.operation === "git.status") {
            if (cwd === undefined)
              throw new Error(`Project ${String(payload.projectId)} was not found.`);
            return (yield* registry.run(
              environmentId,
              subscribe(WS_METHODS.subscribeVcsStatus, { cwd }).pipe(
                Stream.runHead,
                Effect.map(Option.getOrThrow),
              ),
            )) as unknown as Record<string, unknown>;
          }
          if (input.operation === "git.diff") {
            const rawThreadId = String(payload.threadId ?? "");
            const detail = yield* threadSnapshot(environmentId, ThreadId.make(rawThreadId));
            return (yield* registry.run(
              environmentId,
              request(ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
                threadId: ThreadId.make(rawThreadId),
                toTurnCount: detail.thread.messages.filter((message) => message.role === "user")
                  .length,
              }),
            )) as unknown as Record<string, unknown>;
          }
          const prRef = {
            projectId: ProjectId.make(String(payload.projectId ?? "")),
            repository: String(payload.repository ?? ""),
            number: Number(payload.number),
          };
          if (input.operation === "pr.apply_review_fixes") {
            const activity = yield* registry.run(
              environmentId,
              request(WS_METHODS.pullRequestsActivity, prRef),
            );
            const requestedIds = new Set(
              Array.isArray(payload.commentIds)
                ? payload.commentIds.filter((id): id is string => typeof id === "string")
                : [],
            );
            const selectedThreads = activity.reviewThreads.filter((thread) =>
              requestedIds.has(thread.id),
            );
            if (selectedThreads.length !== requestedIds.size) {
              throw new Error("One or more review comment IDs are no longer available.");
            }
            const threadId = ThreadId.make(String(payload.threadId ?? ""));
            const shell = yield* shellSnapshot(environmentId);
            const thread = shell.threads.find((candidate) => candidate.id === threadId);
            if (thread === undefined) throw new Error(`Thread ${threadId} was not found.`);
            const requestId = input.requestId ?? `gateway-pr-fixes-${String(payload.number)}`;
            const instructions = selectedThreads
              .map(
                (reviewThread) =>
                  `${reviewThread.path}:${String(reviewThread.line ?? "file")}\n${reviewThread.comments
                    .map((comment) => comment.body)
                    .join("\n")}`,
              )
              .join("\n\n");
            yield* registry.run(
              environmentId,
              startThreadTurn({
                commandId: CommandId.make(requestId),
                threadId,
                message: {
                  messageId: MessageId.make(`${requestId}-message`),
                  role: "user",
                  text: `Apply only these approved pull request review fixes. Do not resolve review threads; they remain unresolved until the pull request is refreshed.\n\n${instructions}`,
                  attachments: [],
                },
                modelSelection: thread.modelSelection,
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
              }),
            );
            return { queued: true, threadId, reviewThreadIds: [...requestedIds] };
          }
          if (input.operation === "pr.update") {
            yield* registry.run(
              environmentId,
              request(WS_METHODS.pullRequestsUpdate, {
                ...prRef,
                ...(typeof payload.title === "string" ? { title: payload.title } : {}),
                ...(typeof payload.body === "string" ? { body: payload.body } : {}),
              }),
            );
            return { updated: true };
          }
          if (input.operation === "pr.reply") {
            yield* registry.run(
              environmentId,
              request(WS_METHODS.pullRequestsReplyToThread, {
                ...prRef,
                threadId: String(payload.commentId ?? ""),
                body: String(payload.body ?? ""),
              }),
            );
            return { replied: true };
          }
          if (input.operation === "pr.publish") {
            yield* registry.run(
              environmentId,
              request(WS_METHODS.pullRequestsRunAction, { ...prRef, action: "ready" }),
            );
            return { published: true };
          }
          if (input.operation === "git.apply_patch") {
            if (cwd === undefined)
              throw new Error(`Project ${String(payload.projectId)} was not found.`);
            yield* registry.run(
              environmentId,
              request(WS_METHODS.vcsApplyPatch, {
                cwd,
                patch: String(payload.patch),
              }),
            );
            return { applied: true };
          }
          if (input.operation === "git.create_branch") {
            if (cwd === undefined)
              throw new Error(`Project ${String(payload.projectId)} was not found.`);
            return (yield* registry.run(
              environmentId,
              request(WS_METHODS.vcsCreateRef, {
                cwd,
                refName: String(payload.branch ?? ""),
                switchRef: true,
              }),
            )) as unknown as Record<string, unknown>;
          }
          if (input.operation === "git.commit" || input.operation === "git.create_pr") {
            if (cwd === undefined)
              throw new Error(`Project ${String(payload.projectId)} was not found.`);
            const action = input.operation === "git.commit" ? "commit" : "create_pr";
            if (input.operation === "git.create_pr") {
              const refs = yield* registry.run(
                environmentId,
                request(WS_METHODS.vcsListRefs, {
                  cwd,
                  refKind: "all",
                  includeMatchingRemoteRefs: true,
                  refresh: true,
                  limit: 500,
                }),
              );
              const head = refs.refs.find((ref) => ref.current)?.name;
              const defaultRefs = refs.refs
                .filter((ref) => ref.isDefault)
                .map((ref) => ref.name.split("/").at(-1));
              if (
                head !== payload.headBranch ||
                !defaultRefs.includes(String(payload.baseBranch))
              ) {
                throw new Error(
                  "Pull request head/base must match the selected project's current and default refs.",
                );
              }
            }
            const progress = yield* registry.run(
              environmentId,
              runStream(WS_METHODS.gitRunStackedAction, {
                actionId: input.requestId ?? `gateway-${input.operation}`,
                cwd,
                action,
                ...(input.operation === "git.create_pr" && typeof payload.draft === "boolean"
                  ? { draft: payload.draft }
                  : {}),
                ...(typeof payload.message === "string" ? { commitMessage: payload.message } : {}),
                ...(Array.isArray(payload.paths)
                  ? {
                      filePaths: payload.paths.filter(
                        (path): path is string => typeof path === "string",
                      ),
                    }
                  : {}),
              }).pipe(Stream.runLast, Effect.map(Option.getOrThrow)),
            );
            const result =
              typeof progress === "object" &&
              progress !== null &&
              "kind" in progress &&
              progress.kind === "action_finished"
                ? progress.result
                : undefined;
            if (
              input.operation === "git.create_pr" &&
              result?.pr.number !== undefined &&
              typeof payload.owner === "string" &&
              typeof payload.repository === "string" &&
              typeof payload.title === "string"
            ) {
              yield* registry.run(
                environmentId,
                request(WS_METHODS.pullRequestsUpdate, {
                  projectId: ProjectId.make(String(payload.projectId)),
                  repository: payload.repository,
                  number: result.pr.number,
                  title: payload.title,
                  ...(typeof payload.body === "string" ? { body: payload.body } : {}),
                }),
              );
            }
            return (result ?? progress) as unknown as Record<string, unknown>;
          }
          throw new Error(`Gateway operation ${input.operation} is not supported by this runtime.`);
        }),
      ),
  };
  return port;
}
