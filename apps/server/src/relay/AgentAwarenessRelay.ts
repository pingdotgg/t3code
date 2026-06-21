import {
  RelayApi,
  type RelayAgentActivityPublishProofPayload,
  type RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import type {
  EnvironmentId,
  OrchestrationEvent,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import {
  RELAY_ACTIVITY_PUBLISH_TYP,
  signRelayJwt,
  normalizeRelayIssuer,
} from "@t3tools/shared/relayJwt";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export interface AgentAwarenessRelayShape {
  readonly publishThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class AgentAwarenessRelay extends Context.Service<
  AgentAwarenessRelay,
  AgentAwarenessRelayShape
>()("t3/relay/AgentAwarenessRelay") {}

export function eventThreadId(event: OrchestrationEvent): ThreadId | null {
  const payload = event.payload as { readonly threadId?: unknown };
  if (typeof payload.threadId === "string") {
    return payload.threadId as ThreadId;
  }
  if (event.aggregateKind === "thread" && typeof event.aggregateId === "string") {
    return event.aggregateId as ThreadId;
  }
  return null;
}

export function shouldPublishAgentAwarenessEvent(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.message-sent":
      return !event.payload.streaming;
    case "thread.proposed-plan-upserted":
    case "thread.runtime-mode-set":
    case "thread.interaction-mode-set":
      return false;
    case "thread.activity-appended":
      return (
        event.payload.activity.kind === "approval.requested" ||
        event.payload.activity.kind === "approval.resolved" ||
        event.payload.activity.kind === "provider.approval.respond.failed" ||
        event.payload.activity.kind === "user-input.requested" ||
        event.payload.activity.kind === "user-input.resolved" ||
        event.payload.activity.kind === "runtime.error"
      );
    default:
      return true;
  }
}

export function agentAwarenessPublishIdentity(state: RelayAgentActivityState | null): string {
  if (state === null) {
    return "null";
  }
  const { updatedAt: _updatedAt, ...meaningfulState } = state;
  return JSON.stringify(meaningfulState);
}

export function isAgentActivityPublishingEnabled(value: string | null): boolean {
  return value === "true";
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

export function sanitizeRelayAgentActivityState(
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

function relayEnvironmentClient(token: string) {
  return HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", `Bearer ${token}`));
}

function deliveryStats(
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

export function signRelayAgentActivityPublishProof(input: {
  readonly privateKey: string;
  readonly payload: RelayAgentActivityPublishProofPayload;
}) {
  return signRelayJwt({
    privateKey: input.privateKey,
    typ: RELAY_ACTIVITY_PUBLISH_TYP,
    payload: input.payload,
  });
}

const makePublishProof = Effect.fn("makePublishProof")(function* (input: {
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

export function resolveAgentAwarenessRelayPublishSnapshot(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly thread: Option.Option<OrchestrationThreadShell>;
  readonly project: Option.Option<OrchestrationProjectShell>;
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
      projectThreadAwareness({
        environmentId: input.environmentId,
        project: input.project.value,
        thread: input.thread.value,
      }),
    ),
    reason: "snapshot",
  };
}

export function resolveAgentAwarenessRelayActiveThreadIds(input: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<Pick<OrchestrationProjectShell, "id" | "title">>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}): ReadonlyArray<ThreadId> {
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  return input.threads
    .filter((thread) => {
      const project = projectById.get(thread.projectId);
      if (!project) {
        return false;
      }
      return (
        projectThreadAwareness({
          environmentId: input.environmentId,
          project,
          thread,
        }) !== null
      );
    })
    .map((thread) => thread.id);
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const cloudLinkKeyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
  const activeSnapshotPublishedRef = yield* Ref.make(false);
  const publishedStateByThreadRef = yield* Ref.make(new Map<ThreadId, string>());

  const readSecretString = (name: string) =>
    secrets
      .get(name)
      .pipe(
        Effect.map((bytes) =>
          Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null,
        ),
      );

  const readRelayConfig = Effect.gen(function* () {
    const [url, issuer, environmentCredential] = yield* Effect.all([
      readSecretString(RELAY_URL_SECRET),
      readSecretString(RELAY_ISSUER_SECRET),
      readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    return url && environmentCredential
      ? { url, issuer: issuer ?? url, environmentCredential }
      : null;
  });

  const readPublishAgentActivityEnabled = readSecretString(PUBLISH_AGENT_ACTIVITY_SECRET).pipe(
    Effect.map(isAgentActivityPublishingEnabled),
  );

  const makeRelayClient = (relayConfig: {
    readonly url: string;
    readonly environmentCredential: string;
  }) =>
    HttpApiClient.make(RelayApi, {
      baseUrl: relayConfig.url,
      transformClient: relayEnvironmentClient(relayConfig.environmentCredential),
    }).pipe(Effect.provide(FetchHttpClient.layer));

  const publishThreadUnsafe = Effect.fn("publishThreadUnsafe")(function* (threadId: ThreadId) {
    const publishAgentActivity = yield* readPublishAgentActivityEnabled.pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!publishAgentActivity) {
      yield* Effect.logDebug("agent activity publish skipped; publication disabled", {
        threadId,
      });
      return;
    }
    const relayConfig = yield* readRelayConfig.pipe(Effect.orElseSucceed(() => null));
    if (!relayConfig) {
      yield* Effect.logDebug("agent activity publish skipped; relay link credentials unavailable", {
        threadId,
      });
      return;
    }
    const relayClient = yield* makeRelayClient(relayConfig);
    const environmentId = yield* serverEnvironment.getEnvironmentId;

    const publishState = (input: {
      readonly projectId: string | null;
      readonly state: RelayAgentActivityState | null;
      readonly reason: string;
    }) =>
      Effect.gen(function* () {
        const proof = yield* makePublishProof({
          privateKey: cloudLinkKeyPair.privateKey,
          relayIssuer: relayConfig.issuer,
          environmentId,
          threadId,
          state: input.state,
          jti: yield* crypto.randomUUIDv4,
        });

        yield* Effect.logInfo("publishing agent activity for thread", {
          environmentId,
          threadId,
          projectId: input.projectId,
          statePhase: input.state?.phase ?? null,
          hasState: input.state !== null,
          reason: input.reason,
        });

        const response = yield* relayClient.server.publishAgentActivity({
          params: {
            environmentId,
            threadId,
          },
          payload: {
            state: input.state,
            proof,
          },
        });

        yield* Effect.logInfo("agent activity publish completed", {
          environmentId,
          threadId,
          ok: response.ok,
          deliveries: deliveryStats(response.deliveries),
        });
      });

    const thread = yield* snapshotQuery.getThreadShellById(threadId);
    const project = Option.isSome(thread)
      ? yield* snapshotQuery.getProjectShellById(thread.value.projectId)
      : Option.none<OrchestrationProjectShell>();
    const snapshot = resolveAgentAwarenessRelayPublishSnapshot({
      environmentId,
      threadId,
      thread,
      project,
    });
    const publishIdentity = agentAwarenessPublishIdentity(snapshot.state);
    const publishedStateByThread = yield* Ref.get(publishedStateByThreadRef);
    if (publishedStateByThread.get(threadId) === publishIdentity) {
      yield* Effect.logDebug("agent activity publish skipped; projected state unchanged", {
        environmentId,
        threadId,
        reason: snapshot.reason,
      });
      return;
    }

    if (snapshot.reason === "thread-not-found") {
      yield* Effect.logDebug("publishing agent activity tombstone; thread not found", {
        environmentId,
        threadId,
      });
    } else if (snapshot.reason === "project-not-found") {
      yield* Effect.logDebug("publishing agent activity tombstone; project not found", {
        environmentId,
        threadId,
        projectId: snapshot.projectId,
      });
    }

    yield* publishState({
      projectId: snapshot.projectId,
      state: snapshot.state,
      reason: snapshot.reason,
    });
    yield* Ref.update(publishedStateByThreadRef, (publishedStates) => {
      const nextPublishedStates = new Map(publishedStates);
      nextPublishedStates.set(threadId, publishIdentity);
      return nextPublishedStates;
    });
  });

  const publishThread: AgentAwarenessRelayShape["publishThread"] = (threadId) =>
    publishThreadUnsafe(threadId).pipe(
      Effect.catchCause((cause) => {
        return Effect.logWarning("agent activity publish failed", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
      Effect.withSpan("AgentAwarenessRelay.publishThread"),
      withRelayClientTracing,
    );

  const publishActiveThreadsUnsafe = Effect.gen(function* () {
    const publishAgentActivity = yield* readPublishAgentActivityEnabled.pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!publishAgentActivity) {
      yield* Effect.logDebug("agent activity snapshot skipped; publication disabled");
      return false;
    }
    const relayConfig = yield* readRelayConfig.pipe(Effect.orElseSucceed(() => null));
    if (!relayConfig) {
      yield* Effect.logDebug("agent activity snapshot skipped; relay link credentials unavailable");
      return false;
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const snapshot = yield* snapshotQuery.getShellSnapshot();
    const activeThreadIds = resolveAgentAwarenessRelayActiveThreadIds({
      environmentId,
      projects: snapshot.projects,
      threads: snapshot.threads,
    });
    if (activeThreadIds.length === 0) {
      yield* Effect.logDebug("agent activity snapshot has no publishable threads");
      return true;
    }
    yield* Effect.logInfo("publishing active agent activity snapshot", {
      count: activeThreadIds.length,
    });
    yield* Effect.forEach(activeThreadIds, publishThread, { concurrency: 4, discard: true });
    return true;
  });

  const publishActiveThreadsOnceWhenConfigured = (logEnabledWhenReady: boolean) =>
    Effect.gen(function* () {
      while (!(yield* Ref.get(activeSnapshotPublishedRef))) {
        const published = yield* publishActiveThreadsUnsafe.pipe(Effect.orElseSucceed(() => false));
        if (published) {
          yield* Ref.set(activeSnapshotPublishedRef, true);
          if (logEnabledWhenReady) {
            const relayConfig = yield* readRelayConfig.pipe(Effect.orElseSucceed(() => null));
            yield* Effect.logInfo("agent activity publishing enabled after link reconciliation", {
              relayUrl: relayConfig?.url,
            });
          }
          return;
        }
        yield* Effect.sleep("5 seconds");
      }
    });

  const worker = yield* makeDrainableWorker(publishThread);

  const start: AgentAwarenessRelayShape["start"] = Effect.fn("AgentAwarenessRelay.start")(
    function* () {
      const [relayConfig, publishEnabled] = yield* Effect.all([
        readRelayConfig.pipe(Effect.orElseSucceed(() => null)),
        readPublishAgentActivityEnabled.pipe(Effect.orElseSucceed(() => false)),
      ]);
      const startupState = resolveAgentActivityPublishingStartupState({
        relayConfigured: relayConfig !== null,
        publishEnabled,
      });
      switch (startupState) {
        case "waiting-for-link":
          yield* Effect.logInfo(
            "agent activity publishing standby; waiting for T3 Connect link reconciliation",
          );
          break;
        case "disabled":
          yield* Effect.logInfo("agent activity publishing disabled by T3 Connect configuration");
          break;
        case "enabled":
          yield* Effect.logInfo("agent activity publishing enabled", {
            relayUrl: relayConfig?.url,
          });
          break;
      }
      yield* Effect.forkScoped(
        Effect.sleep("1 second").pipe(
          Effect.andThen(publishActiveThreadsOnceWhenConfigured(startupState !== "enabled")),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          const threadId = eventThreadId(event);
          if (threadId === null) {
            return Effect.logDebug("agent activity publishing ignored event without thread id", {
              eventType: event.type,
            });
          }
          if (!shouldPublishAgentAwarenessEvent(event)) {
            return Effect.logDebug(
              "agent activity publishing ignored event without activity changes",
              {
                eventType: event.type,
                threadId,
              },
            );
          }
          return Effect.logDebug("agent activity publishing queued thread publish", {
            eventType: event.type,
            threadId,
          }).pipe(Effect.andThen(worker.enqueue(threadId)));
        }),
      );
    },
  );

  return {
    publishThread,
    start,
  } satisfies AgentAwarenessRelayShape;
});

export const layer = Layer.effect(AgentAwarenessRelay, make);
