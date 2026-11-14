import {
  isListedThreadLineage,
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type Project,
  type ThreadId,
} from "@t3tools/contracts";
import {
  RelayApi,
  type RelayAgentActivityPublishProofPayload,
  type RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import {
  normalizeRelayIssuer,
  RELAY_ACTIVITY_PUBLISH_TYP,
  signRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  isAgentActivityPublishingEnabledValue,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import { make } from "./AgentAwarenessRelayParts.ts";

export class AgentAwarenessRelay extends Context.Service<
  AgentAwarenessRelay,
  {
    readonly publishThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
    readonly requestCatchUp: () => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/relay/AgentAwarenessRelay") {}

export function eventThreadId(event: OrchestrationV2DomainEvent): ThreadId {
  return event.threadId;
}

function isTurnItemPayload(
  payload: unknown,
): payload is Pick<OrchestrationV2TurnItem, "type" | "status"> {
  return (
    typeof payload === "object" && payload !== null && "type" in payload && "status" in payload
  );
}

export function shouldPublishAgentAwarenessEvent(
  event: Pick<OrchestrationV2DomainEvent, "type"> & { readonly payload?: unknown },
): boolean {
  if (
    event.type === "thread.created" &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    "historyOrigin" in event.payload &&
    event.payload.historyOrigin === "v1_import"
  ) {
    return false;
  }
  switch (event.type) {
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.metadata-updated":
    case "thread.pull-request-link-updated":
    case "thread.pull-request-synced":
    case "thread.settled":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
    case "run.created":
    case "run.updated":
    case "runtime-request.updated":
    case "subagent.updated":
    case "provider-thread.updated":
      return true;
    // Unsettling must not re-alert a dismissed result.
    case "thread.unsettled":
    case "thread.guest-share-updated":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.auto-settle-set":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.active-reordered":
    case "thread.tags-updated":
    case "thread.visited":
    case "thread.marked-unread":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "run.background-work-cancelled":
    case "run-attempt.created":
    case "run-attempt.updated":
    case "node.updated":
    case "provider-session.attached":
    case "provider-session.updated":
    case "provider-session.detached":
    case "provider-turn.updated":
    case "turn-item.updated":
      return isTurnItemPayload(event.payload) && turnItemUpdateCanEndBackgroundWork(event.payload);
    case "message.updated":
    case "plan.updated":
    case "checkpoint-scope.created":
    case "checkpoint.captured":
    case "checkpoint.rollback-requested":
    case "context-handoff.updated":
    case "context-transfer.created":
    case "context-transfer.updated":
      return false;
  }
}

export const makeAgentAwarenessPublishWorker = Effect.fnUntraced(function* <R>(
  publish: (threadId: ThreadId) => Effect.Effect<void, never, R>,
) {
  const queued = new Set<ThreadId>();
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => queued.delete(threadId)).pipe(Effect.andThen(publish(threadId))),
  );
  const enqueue = (threadId: ThreadId) =>
    Effect.suspend(() => {
      if (queued.has(threadId)) return Effect.void;
      // Remove queued IDs when processing starts so publication can queue one later update.
      queued.add(threadId);
      return worker.enqueue(threadId);
    }).pipe(Effect.uninterruptible);
  return { enqueue, drain: worker.drain };
});

export function agentAwarenessPublishIdentity(state: RelayAgentActivityState | null): string {
  if (state === null) {
    return "null";
  }
  const { updatedAt: _updatedAt, ...meaningfulState } = state;
  return JSON.stringify(meaningfulState);
}

const CLEARED_PUBLISH_IDENTITY = agentAwarenessPublishIdentity(null);

// A published tombstone stays recorded so repeats are skipped, but it is not live state.
export function hasLivePublishedState(
  publishedStateByThread: ReadonlyMap<ThreadId, string>,
  threadId: ThreadId,
): boolean {
  const identity = publishedStateByThread.get(threadId);
  return identity !== undefined && identity !== CLEARED_PUBLISH_IDENTITY;
}

export function resolveAgentActivityPublishingStartupState(input: {
  readonly relayConfigured: boolean;
  readonly publishEnabled: boolean;
}): "waiting-for-link" | "disabled" | "enabled" {
  if (!input.relayConfigured) {
    return "waiting-for-link";
  }
  return input.publishEnabled ? "enabled" : "disabled";
}

const RELAY_AGENT_ACTIVITY_DETAIL_MAX_LENGTH = 160;
const REDACTED_RELAY_AGENT_FAILURE_DETAIL = "The agent run failed.";
export const RELAY_AGENT_ACTIVITY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

function sanitizeRelayAgentActivityState(
  state: RelayAgentActivityState | null,
): RelayAgentActivityState | null {
  if (state === null) {
    return null;
  }
  const { detail: _detail, ...rest } = state;
  const detail = (state.phase === "failed" ? REDACTED_RELAY_AGENT_FAILURE_DETAIL : state.detail)
    ?.trim()
    .slice(0, RELAY_AGENT_ACTIVITY_DETAIL_MAX_LENGTH)
    .trim();
  return detail ? { ...rest, detail } : rest;
}

export function relayEnvironmentClient(token: string) {
  return HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${token}`));
}

export function deliveryStats(
  deliveries: ReadonlyArray<{
    readonly ok: boolean;
    readonly queued?: boolean | undefined;
    readonly kind: string;
    readonly apnsStatus?: number | null;
    readonly apnsReason?: string | null;
  }>,
) {
  let queued = 0;
  let successful = 0;
  let failed = 0;
  const failedReasons: string[] = [];
  const kinds = new Set<string>();

  for (const delivery of deliveries) {
    kinds.add(delivery.kind);
    if (delivery.queued) {
      queued += 1;
      continue;
    }
    if (delivery.ok) {
      successful += 1;
      continue;
    }
    failed += 1;
    failedReasons.push(`${delivery.apnsStatus ?? "transport"}:${delivery.apnsReason ?? "unknown"}`);
  }

  return {
    total: deliveries.length,
    queued,
    successful,
    failed,
    kinds: [...kinds],
    failedReasons,
  };
}

function signRelayAgentActivityPublishProof(input: {
  readonly privateKey: string;
  readonly payload: RelayAgentActivityPublishProofPayload;
}) {
  return signRelayJwt({
    privateKey: input.privateKey,
    typ: RELAY_ACTIVITY_PUBLISH_TYP,
    payload: input.payload,
  });
}

export const makePublishProof = Effect.fn("makePublishProof")(function* (input: {
  readonly privateKey: string;
  readonly relayIssuer: string;
  readonly environmentId: string;
  readonly threadId: ThreadId;
  readonly state: RelayAgentActivityState | null;
  readonly jti: string;
}) {
  const now = yield* DateTime.now;
  const expiresAt = DateTime.add(now, { minutes: 5 });
  const payload = {
    iss: `t3-env:${input.environmentId}`,
    aud: normalizeRelayIssuer(input.relayIssuer),
    sub: input.environmentId,
    jti: input.jti,
    iat: Math.floor(now.epochMilliseconds / 1_000),
    exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
    environmentId: input.environmentId as RelayAgentActivityPublishProofPayload["environmentId"],
    threadId: input.threadId,
    state: input.state,
  } satisfies RelayAgentActivityPublishProofPayload;
  return yield* signRelayAgentActivityPublishProof({ privateKey: input.privateKey, payload });
});

export function describeThreadShellForAwareness(
  thread: Option.Option<OrchestrationV2ThreadShell>,
): Record<string, unknown> {
  if (Option.isNone(thread)) {
    return { found: false };
  }
  const shell = thread.value;
  return {
    found: true,
    status: shell.status,
    activityRunStatus: shell.activityRunStatus ?? null,
    activeRunId: shell.activeRunId ?? null,
    latestRunId: shell.latestRunId ?? null,
    pendingRuntimeRequestKind: shell.pendingRuntimeRequest?.kind ?? null,
    hasActionableProposedPlan: shell.hasActionableProposedPlan,
  };
}

export function resolveAgentAwarenessRelayPublishSnapshot(input: {
  readonly environmentId: EnvironmentId;
  readonly thread: Option.Option<OrchestrationV2ThreadShell>;
  readonly project: Option.Option<Project>;
}): {
  readonly projectId: string | null;
  readonly state: RelayAgentActivityState | null;
  readonly reason: "snapshot" | "thread-not-found" | "project-not-found";
} {
  if (Option.isNone(input.thread)) {
    return {
      projectId: null,
      state: null,
      reason: "thread-not-found",
    };
  }
  if (Option.isNone(input.project)) {
    return {
      projectId: input.thread.value.projectId,
      state: null,
      reason: "project-not-found",
    };
  }
  return {
    projectId: input.thread.value.projectId,
    state: sanitizeRelayAgentActivityState(
      projectThreadAwarenessV2({
        environmentId: input.environmentId,
        project: input.project.value,
        thread: input.thread.value,
      }),
    ),
    reason: "snapshot",
  };
}

export function terminalWorkSinceStart(thread: OrchestrationV2ThreadShell, startedAt: number): boolean {
  return (
    thread.latestRunCompletedAt != null &&
    DateTime.toEpochMillis(thread.latestRunCompletedAt) > startedAt
  );
}

export function resolveAgentAwarenessRelayActiveThreadIds(input: {
  readonly environmentId: EnvironmentId;
  readonly startedAt: number;
  readonly projects: ReadonlyArray<Pick<Project, "id" | "title">>;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}): ReadonlyArray<ThreadId> {
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  return input.threads
    .filter((thread) => {
      const project = projectById.get(thread.projectId);
      if (!project) {
        return false;
      }
      const state = projectThreadAwarenessV2({
        environmentId: input.environmentId,
        project,
        thread,
      });
      return (
        state !== null &&
        (state.phase !== "completed" && state.phase !== "failed"
          ? true
          : terminalWorkSinceStart(thread, input.startedAt))
      );
    })
    .map((thread) => thread.id);
}

/** @public */
export const layer = Layer.effect(AgentAwarenessRelay, make);
export * from "./AgentAwarenessRelayParts.ts";
