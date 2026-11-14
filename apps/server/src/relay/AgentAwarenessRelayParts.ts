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
import { AgentAwarenessRelay, RELAY_AGENT_ACTIVITY_RETRY_DELAYS_MS, agentAwarenessPublishIdentity, deliveryStats, describeThreadShellForAwareness, eventThreadId, hasLivePublishedState, makeAgentAwarenessPublishWorker, makePublishProof, relayEnvironmentClient, resolveAgentActivityPublishingStartupState, resolveAgentAwarenessRelayActiveThreadIds, resolveAgentAwarenessRelayPublishSnapshot, shouldPublishAgentAwarenessEvent, terminalWorkSinceStart } from "./AgentAwarenessRelay.ts";

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const scope = yield* Effect.scope;
  const cloudLinkKeyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
  const startedAt = (yield* DateTime.now).epochMilliseconds;
  const catchUpRequests = yield* Queue.dropping<void>(1);
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
    Effect.map(isAgentActivityPublishingEnabledValue),
  );

  const makeRelayClient = (relayConfig: {
    readonly url: string;
    readonly environmentCredential: string;
  }) =>
    HttpApiClient.make(RelayApi, {
      baseUrl: relayConfig.url,
      transformClient: relayEnvironmentClient(relayConfig.environmentCredential),
    }).pipe(Effect.provide(FetchHttpClient.layer));

  let cachedRelayClient: Effect.Success<ReturnType<typeof makeRelayClient>> | undefined;
  let publishedRelayConfig: NonNullable<Effect.Success<typeof readRelayConfig>> | undefined;

  // Confirm through the same worker so tombstones cannot race live updates; recovery clears the deadline.
  const publishConfirmDeadlines = new Map<ThreadId, number>();
  // Threads whose confirmation holds a completion, so a thread that settles during the hold still alerts.
  const heldCompletions = new Set<ThreadId>();
  let schedulePublishConfirm: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;
  const publishRetries = new Map<
    ThreadId,
    { readonly attempts: number; timer: Fiber.Fiber<void> | undefined }
  >();
  const cancelPublishRetry = Effect.fnUntraced(function* (threadId: ThreadId) {
    const retry = publishRetries.get(threadId);
    publishRetries.delete(threadId);
    if (retry?.timer !== undefined) yield* Fiber.interrupt(retry.timer);
  });
  const cancelPublishRetries = Effect.suspend(() =>
    Effect.forEach([...publishRetries.keys()], cancelPublishRetry, { discard: true }),
  );
  let schedulePublishRetry: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;
  const resetPublishedConnection = Effect.gen(function* () {
    publishedRelayConfig = undefined;
    cachedRelayClient = undefined;
    publishConfirmDeadlines.clear();
    heldCompletions.clear();
    yield* Ref.set(publishedStateByThreadRef, new Map());
  });

  const publishThreadUnsafe = Effect.fn("publishThreadUnsafe")(function* (threadId: ThreadId) {
    const publishAgentActivity = yield* readPublishAgentActivityEnabled;
    if (!publishAgentActivity) {
      yield* cancelPublishRetries;
      yield* resetPublishedConnection;
      yield* Effect.logDebug("agent activity publish skipped; publication disabled", {
        threadId,
      });
      return;
    }
    const relayConfig = yield* readRelayConfig;
    if (!relayConfig) {
      yield* cancelPublishRetries;
      yield* resetPublishedConnection;
      yield* Effect.logDebug("agent activity publish skipped; relay link credentials unavailable", {
        threadId,
      });
      return;
    }
    if (
      publishedRelayConfig?.url !== relayConfig.url ||
      publishedRelayConfig.issuer !== relayConfig.issuer ||
      publishedRelayConfig.environmentCredential !== relayConfig.environmentCredential
    ) {
      yield* resetPublishedConnection;
      publishedRelayConfig = relayConfig;
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;

    const publishState = Effect.fn("relay.agent_activity.publish")(function* (input: {
      readonly projectId: string | null;
      readonly state: RelayAgentActivityState | null;
      readonly reason: string;
    }) {
      if (cachedRelayClient === undefined) {
        cachedRelayClient = yield* makeRelayClient(relayConfig);
      }
      const relayClient = cachedRelayClient;
      const proof = yield* makePublishProof({
        privateKey: cloudLinkKeyPair.privateKey,
        relayIssuer: relayConfig.issuer,
        environmentId,
        threadId,
        state: input.state,
        jti: yield* random.uuidV4(),
      });

      yield* Effect.logInfo("publishing agent activity for thread", {
        environmentId,
        threadId,
        projectId: input.projectId,
        statePhase: input.state?.phase ?? null,
        hasState: input.state !== null,
        reason: input.reason,
      });

      const response = yield* relayClient.server
        .publishAgentActivity({
          params: {
            environmentId,
            threadId,
          },
          payload: {
            state: input.state,
            proof,
          },
        })
        .pipe(Effect.timeout("10 seconds"));

      yield* Effect.logInfo("agent activity publish completed", {
        environmentId,
        threadId,
        ok: response.ok,
        deliveries: deliveryStats(response.deliveries),
      });
    });

    // Read only this thread; full shell reads would make each activity event scale with all threads.
    const threadShell = yield* threads.getThreadShell(threadId);
    if (
      threadShell !== null &&
      !isListedThreadLineage(threadShell.lineage) &&
      !hasLivePublishedState(yield* Ref.get(publishedStateByThreadRef), threadId)
    ) {
      // Subagents and side chats have no relay rows to clear; per-event tombstones would needlessly redeliver user aggregates.
      return;
    }
    const thread =
      threadShell === null || threadShell.archivedAt !== null
        ? Option.none<OrchestrationV2ThreadShell>()
        : Option.some(threadShell);
    const project = Option.isSome(thread)
      ? yield* projects.getById(thread.value.projectId)
      : Option.none<Project>();
    const snapshot = resolveAgentAwarenessRelayPublishSnapshot({
      environmentId,
      thread,
      project,
    });
    const publishIdentity = agentAwarenessPublishIdentity(snapshot.state);
    const publishedStateByThread = yield* Ref.get(publishedStateByThreadRef);
    if (
      (snapshot.state?.phase === "completed" || snapshot.state?.phase === "failed") &&
      !hasLivePublishedState(publishedStateByThread, threadId)
    ) {
      if (Option.isNone(thread) || !terminalWorkSinceStart(thread.value, startedAt)) return;
    }
    if (
      publishedStateByThread.get(threadId) === publishIdentity &&
      // A held completion settled after an earlier clear still has to alert.
      !(snapshot.state === null && heldCompletions.has(threadId))
    ) {
      // Clear moot deadlines so later transient nulls cannot skip their deferral window.
      publishConfirmDeadlines.delete(threadId);
      heldCompletions.delete(threadId);
      yield* Effect.logDebug("agent activity publish skipped; projected state unchanged", {
        environmentId,
        threadId,
        reason: snapshot.reason,
      });
      return;
    }

    // Confirm tombstones over live state to avoid removing active cards.
    // Confirm completion: a run can end moments before its continuation starts, and the relay
    // alerts on every move into completed.
    const requiresConfirmation = snapshot.state === null || snapshot.state?.phase === "completed";
    if (requiresConfirmation) {
      if (snapshot.state?.phase === "completed") heldCompletions.add(threadId);
      const nowMs = (yield* DateTime.now).epochMilliseconds;
      const deadline = publishConfirmDeadlines.get(threadId);
      if (deadline === undefined) {
        publishConfirmDeadlines.set(threadId, nowMs + 5_000);
        yield* Effect.logInfo("agent activity publish deferred pending confirmation", {
          environmentId,
          threadId,
          reason: snapshot.reason,
          statePhase: snapshot.state?.phase ?? null,
          shell: describeThreadShellForAwareness(thread),
        });
        yield* schedulePublishConfirm(threadId);
        return;
      }
      if (nowMs < deadline) {
        return;
      }
      yield* Effect.logInfo("agent activity deferred publish confirmed", {
        environmentId,
        threadId,
        reason: snapshot.reason,
        statePhase: snapshot.state?.phase ?? null,
        shell: describeThreadShellForAwareness(thread),
      });
      // Settled during the hold, not resumed: alert the current completion, then clear the card
      // on a new window. Only settlement may hide it; queued or silent runs also project to null.
      const unsettled =
        snapshot.state === null &&
        heldCompletions.has(threadId) &&
        Option.isSome(thread) &&
        thread.value.settledOverride === "settled"
          ? resolveAgentAwarenessRelayPublishSnapshot({
              environmentId,
              thread: Option.some({ ...thread.value, settledOverride: null }),
              project,
            })
          : null;
      if (unsettled?.state?.phase === "completed") {
        const completion = unsettled.state;
        yield* publishState({
          projectId: unsettled.projectId,
          state: completion,
          reason: unsettled.reason,
        }).pipe(withRelayClientTracing);
        heldCompletions.delete(threadId);
        publishConfirmDeadlines.set(threadId, nowMs + 5_000);
        yield* Ref.update(publishedStateByThreadRef, (publishedStates) =>
          new Map(publishedStates).set(threadId, agentAwarenessPublishIdentity(completion)),
        );
        yield* schedulePublishConfirm(threadId);
        return;
      }
    } else {
      publishConfirmDeadlines.delete(threadId);
      heldCompletions.delete(threadId);
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
    }).pipe(withRelayClientTracing);
    publishConfirmDeadlines.delete(threadId);
    heldCompletions.delete(threadId);
    yield* Ref.update(publishedStateByThreadRef, (publishedStates) =>
      new Map(publishedStates).set(threadId, publishIdentity),
    );
  });

  const processThreadPublish = Effect.fnUntraced(function* (threadId: ThreadId) {
    const retry = publishRetries.get(threadId);
    if (retry?.timer !== undefined) {
      const timer = retry.timer;
      retry.timer = undefined;
      yield* Fiber.interrupt(timer);
    }
    yield* publishThreadUnsafe(threadId).pipe(
      Effect.tap(() => cancelPublishRetry(threadId)),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;
        return Effect.logWarning("agent activity publish failed", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.andThen(schedulePublishRetry(threadId)));
      }),
      Effect.withSpan("AgentAwarenessRelay.publishThread"),
    );
  });

  const worker = yield* makeAgentAwarenessPublishWorker(processThreadPublish);
  const enqueueThreadPublish = (threadId: ThreadId) =>
    cancelPublishRetry(threadId).pipe(Effect.andThen(worker.enqueue(threadId)));
  const publishThread: AgentAwarenessRelay["Service"]["publishThread"] = (threadId) =>
    enqueueThreadPublish(threadId).pipe(Effect.andThen(worker.drain));

  schedulePublishRetry = Effect.fnUntraced(function* (threadId: ThreadId) {
    const attempts = publishRetries.get(threadId)?.attempts ?? 0;
    const delayMs = RELAY_AGENT_ACTIVITY_RETRY_DELAYS_MS[attempts];
    if (delayMs === undefined) {
      // Retain exhausted budgets until activity or success resets them; old timers must not restart retries.
      yield* Effect.logWarning("agent activity publish retry budget exhausted", { threadId });
      return;
    }
    const retry = {
      attempts: attempts + 1,
      timer: undefined as Fiber.Fiber<void> | undefined,
    };
    publishRetries.set(threadId, retry);
    const timer = yield* Effect.sleep(delayMs).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (publishRetries.get(threadId) !== retry) return Effect.void;
          retry.timer = undefined;
          return worker.enqueue(threadId);
        }),
      ),
      Effect.forkIn(scope),
    );
    if (publishRetries.get(threadId) !== retry) {
      yield* Fiber.interrupt(timer);
    } else {
      retry.timer = timer;
    }
  });

  const publishActiveThreadsUnsafe = Effect.gen(function* () {
    const relayUrl = yield* readSecretString(RELAY_URL_SECRET).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!relayUrl) {
      yield* Effect.logDebug("agent activity snapshot skipped; relay link credentials unavailable");
      return "unlinked" as const;
    }
    const publishAgentActivity = yield* readPublishAgentActivityEnabled.pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!publishAgentActivity) {
      yield* Effect.logDebug("agent activity snapshot skipped; publication disabled");
      return "disabled" as const;
    }
    const relayConfig = yield* readRelayConfig.pipe(Effect.orElseSucceed(() => null));
    if (!relayConfig) {
      yield* Effect.logDebug("agent activity snapshot skipped; relay link credentials unavailable");
      return "unlinked" as const;
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const projectSnapshot = yield* projects.snapshot;
    // Subagents and side chats never publish awareness, and subagents are most threads.
    const topLevelThreadIds = (yield* threads.listActiveShellIndex()).flatMap((thread) =>
      isListedThreadLineage(thread.lineage) ? [thread.id] : [],
    );
    const shellSnapshot = yield* threads.getShellSnapshot({
      location: "active",
      threadIds: topLevelThreadIds,
    });
    const activeThreadIds = resolveAgentAwarenessRelayActiveThreadIds({
      environmentId,
      startedAt,
      projects: projectSnapshot.projects,
      threads: shellSnapshot.threads,
    });
    if (activeThreadIds.length === 0) {
      yield* Effect.logDebug("agent activity snapshot has no publishable threads");
      return "published" as const;
    }
    yield* Effect.logInfo("publishing active agent activity snapshot", {
      count: activeThreadIds.length,
    });
    yield* Effect.forEach(activeThreadIds, enqueueThreadPublish, { discard: true });
    yield* worker.drain;
    return "published" as const;
  });

  // Many environments never link, so while unlinked the retry backs off from 5
  // s to 60 s. A linked environment keeps the 5 s retry, because `t3 connect
  // publish` can turn publishing on from another process. Keep this untraced:
  // an unlinked environment can retry for the lifetime of the process.
  const publishActiveThreadsWhenConfigured = Effect.fnUntraced(function* (
    logEnabledWhenReady: boolean,
  ) {
    let unlinkedRetryDelayMs = 5_000;
    while (true) {
      const result = yield* publishActiveThreadsUnsafe.pipe(
        Effect.orElseSucceed(() => "failed" as const),
      );
      if (result === "published") {
        if (logEnabledWhenReady) {
          const relayConfig = yield* readRelayConfig.pipe(Effect.orElseSucceed(() => null));
          yield* Effect.logInfo("agent activity publishing enabled after link reconciliation", {
            relayUrl: relayConfig?.url,
          });
        }
        logEnabledWhenReady = false;
        unlinkedRetryDelayMs = 5_000;
        yield* Queue.take(catchUpRequests);
        continue;
      }
      const retryDelayMs = result === "unlinked" ? unlinkedRetryDelayMs : 5_000;
      yield* Effect.race(Effect.sleep(retryDelayMs), Queue.take(catchUpRequests));
      if (result === "unlinked") {
        unlinkedRetryDelayMs = Math.min(unlinkedRetryDelayMs * 2, 60_000);
      }
    }
  });

  schedulePublishConfirm = (threadId) =>
    Effect.forkIn(
      Effect.sleep("5 seconds").pipe(
        Effect.andThen(worker.enqueue(threadId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("deferred agent activity confirmation failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
      scope,
    ).pipe(Effect.asVoid);

  const start: AgentAwarenessRelay["Service"]["start"] = Effect.fn("AgentAwarenessRelay.start")(
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
      yield* forkParked(
        Effect.sleep("1 second").pipe(
          Effect.andThen(publishActiveThreadsWhenConfigured(startupState !== "enabled")),
        ),
      );
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) => {
          const threadId = eventThreadId(event);
          if (!shouldPublishAgentAwarenessEvent(event)) {
            return Effect.void;
          }
          return Effect.logDebug("agent activity publishing queued thread publish", {
            eventType: event.type,
            threadId,
          }).pipe(Effect.andThen(enqueueThreadPublish(threadId)));
        }),
      );
    },
  );

  return AgentAwarenessRelay.of({
    publishThread,
    drain: worker.drain,
    requestCatchUp: Effect.fn("AgentAwarenessRelay.requestCatchUp")(function () {
      return Queue.offer(catchUpRequests, undefined).pipe(Effect.asVoid);
    }),
    start,
  });
});

