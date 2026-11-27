import {
  NonNegativeInt,
  TEAM_WS_METHODS,
  ThreadId,
  type AssetResource,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type DeviceServiceState,
  type EnvironmentAuthorizationError,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2SearchThreadsResult,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadLinkMetadata,
  type OrchestrationV2ThreadStreamItem,
  type PreviewEvent,
  type ProjectId,
  type TeamViewId,
  type TerminalMetadataStreamEvent,
} from "@t3tools/contracts";
import { derive as deriveOrchestrationId } from "@t3tools/provider-core/server/IdAllocator";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import type * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import type { ThreadLaunchResult } from "../orchestration-v2/ThreadLaunchService.ts";
import type * as PeerClientPairing from "../peer/PeerClientPairing.ts";
import type * as PeerLinks from "../peer/PeerLinks.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import type * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import type * as TeamProviderManager from "./TeamProviderManager.ts";
import * as TeamService from "./TeamService.ts";
import {
  adaptSearchThreadsResultForUpstreamCompat,
  adaptShellSnapshotForUpstreamCompat,
  adaptShellStreamItemForUpstreamCompat,
  adaptThreadLinkMetadataForUpstreamCompat,
  adaptThreadStreamItemForUpstreamCompat,
  adaptThreadTitlesForUpstreamCompat,
} from "./upstreamMobileCompat.ts";

export interface TeamWsHandlerDeps {
  readonly callerScopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly serverAuth?: EnvironmentAuth.EnvironmentAuth["Service"];
  readonly peerLinks?: PeerLinks.PeerLinks["Service"];
  readonly peerClientPairing?: PeerClientPairing.PeerClientPairing["Service"];
  readonly projectService?: ProjectService.ProjectService["Service"];
  readonly eventSink?: EventSink.EventSinkV2["Service"];
  readonly projectionStore?: ProjectionStore.ProjectionStoreV2["Service"];
  readonly teamProviderManager?: TeamProviderManager.TeamProviderManager["Service"];
  readonly scheduledTaskService?: ScheduledTasks.ScheduledTaskService["Service"];
  readonly awaitSocketDisconnect?: Effect.Effect<void>;
}

export function makeTeamWsRpcHandlers(
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
  deps?: TeamWsHandlerDeps,
) {
  return {
    [TEAM_WS_METHODS.teamGetState]: () => teamService.getState(sessionId),
    [TEAM_WS_METHODS.teamSubscribeState]: () => teamService.streamState(sessionId),
    [TEAM_WS_METHODS.teamInitialize]: (
      payload: Parameters<typeof teamService.initializeTeam>[0]["payload"],
    ) => teamService.initializeTeam({ sessionId, payload }),
    [TEAM_WS_METHODS.teamLeave]: () =>
      teamService.leaveTeam({
        sessionId,
        deferCallerSessionRevocation:
          deps?.awaitSocketDisconnect !== undefined
            ? {
                awaitDisconnect: deps.awaitSocketDisconnect,
                fallbackDelay: Duration.millis(500),
              }
            : true,
        ...(deps?.peerClientPairing !== undefined
          ? { peerClientPairing: deps.peerClientPairing }
          : {}),
        ...(deps?.peerLinks !== undefined ? { peerLinks: deps.peerLinks } : {}),
      }),
    [TEAM_WS_METHODS.teamDelete]: (
      payload: Parameters<typeof teamService.deleteTeam>[0]["payload"],
    ) =>
      teamService.deleteTeam({
        sessionId,
        payload,
        ...(deps?.peerClientPairing !== undefined
          ? { peerClientPairing: deps.peerClientPairing }
          : {}),
        ...(deps?.peerLinks !== undefined ? { peerLinks: deps.peerLinks } : {}),
        ...(deps?.teamProviderManager !== undefined
          ? { teamProviderManager: deps.teamProviderManager }
          : {}),
        ...(deps?.scheduledTaskService !== undefined
          ? { scheduledTaskService: deps.scheduledTaskService }
          : {}),
      }),
    [TEAM_WS_METHODS.teamUpdateDisplayName]: (
      payload: Parameters<typeof teamService.updateDisplayName>[0]["payload"],
    ) => teamService.updateDisplayName({ sessionId, payload }),
    [TEAM_WS_METHODS.teamUpdateMyPseudo]: (
      payload: Parameters<typeof teamService.updateMyPseudo>[0]["payload"],
    ) => teamService.updateMyPseudo({ sessionId, payload }),
    [TEAM_WS_METHODS.teamUpdateMemberRole]: (
      payload: Parameters<typeof teamService.updateMemberRole>[0]["payload"],
    ) =>
      teamService.updateMemberRole({
        sessionId,
        payload,
        ...(deps?.peerClientPairing !== undefined
          ? { peerClientPairing: deps.peerClientPairing }
          : {}),
        ...(deps?.peerLinks !== undefined ? { peerLinks: deps.peerLinks } : {}),
      }),
    [TEAM_WS_METHODS.teamUpdateMemberStatus]: (
      payload: Parameters<typeof teamService.updateMemberStatus>[0]["payload"],
    ) =>
      teamService.updateMemberStatus({
        sessionId,
        payload,
        ...(deps?.peerClientPairing !== undefined
          ? { peerClientPairing: deps.peerClientPairing }
          : {}),
        ...(deps?.peerLinks !== undefined ? { peerLinks: deps.peerLinks } : {}),
      }),
    [TEAM_WS_METHODS.teamCreateInvite]: (
      payload: Parameters<typeof teamService.createInvite>[0]["payload"],
    ) => teamService.createInvite({ sessionId, payload }),
    [TEAM_WS_METHODS.teamRevokeInvite]: (
      payload: Parameters<typeof teamService.revokeInvite>[0]["payload"],
    ) => teamService.revokeInvite({ sessionId, payload }),
    [TEAM_WS_METHODS.teamCreateView]: (
      payload: Parameters<typeof teamService.createView>[0]["payload"],
    ) => teamService.createView({ sessionId, payload }),
    [TEAM_WS_METHODS.teamUpdateView]: (
      payload: Parameters<typeof teamService.updateView>[0]["payload"],
    ) => teamService.updateView({ sessionId, payload }),
    [TEAM_WS_METHODS.teamDeleteView]: (
      payload: Parameters<typeof teamService.deleteView>[0]["payload"],
    ) => teamService.deleteView({ sessionId, payload }),
    [TEAM_WS_METHODS.teamSetThreadView]: (
      payload: Parameters<typeof teamService.setThreadView>[0]["payload"],
    ) => teamService.setThreadView({ sessionId, payload }),
    [TEAM_WS_METHODS.teamSetThreadLocked]: (
      payload: Parameters<typeof teamService.setThreadLocked>[0]["payload"],
    ) => teamService.setThreadLocked({ sessionId, payload }),
    [TEAM_WS_METHODS.teamListThreadAttributions]: () =>
      teamService
        .listThreadAttributions(sessionId)
        .pipe(Effect.map((attributions) => ({ attributions }))),
    [TEAM_WS_METHODS.teamFollowThread]: (
      payload: Parameters<typeof teamService.followThread>[0]["payload"],
    ) => teamService.followThread({ sessionId, payload }),
    [TEAM_WS_METHODS.teamUnfollowThread]: (
      payload: Parameters<typeof teamService.unfollowThread>[0]["payload"],
    ) => teamService.unfollowThread({ sessionId, payload }),
    [TEAM_WS_METHODS.teamListFollowedThreads]: () =>
      teamService
        .listFollowedThreads(sessionId)
        .pipe(Effect.map((followedThreadIds) => ({ followedThreadIds }))),
    [TEAM_WS_METHODS.teamAssignProject]: (
      payload: Parameters<typeof teamService.assignProject>[0]["payload"],
    ) =>
      teamService.assignProject({
        sessionId,
        payload,
        ...(deps?.projectService !== undefined ? { projectService: deps.projectService } : {}),
      }),
    [TEAM_WS_METHODS.teamUnassignProject]: (
      payload: Parameters<typeof teamService.unassignProject>[0]["payload"],
    ) => teamService.unassignProject({ sessionId, payload }),
    [TEAM_WS_METHODS.teamAttachEnvironment]: (
      payload: Parameters<typeof teamService.attachEnvironment>[0]["payload"],
    ) =>
      teamService.attachEnvironment({
        sessionId,
        payload,
        ...(deps?.peerLinks !== undefined ? { peerLinks: deps.peerLinks } : {}),
      }),
    [TEAM_WS_METHODS.teamUpdateEnvironment]: (
      payload: Parameters<typeof teamService.updateEnvironment>[0]["payload"],
    ) =>
      teamService.updateEnvironment({
        sessionId,
        payload,
        ...(deps?.peerClientPairing !== undefined
          ? { peerClientPairing: deps.peerClientPairing }
          : {}),
      }),
    [TEAM_WS_METHODS.teamDetachEnvironment]: (
      payload: Parameters<typeof teamService.detachEnvironment>[0]["payload"],
    ) =>
      teamService.detachEnvironment({
        sessionId,
        payload,
        ...(deps?.peerLinks !== undefined ? { peerLinks: deps.peerLinks } : {}),
        ...(deps?.peerClientPairing !== undefined
          ? { peerClientPairing: deps.peerClientPairing }
          : {}),
      }),
    [TEAM_WS_METHODS.teamSyncLocalThread]: (
      payload: Parameters<typeof teamService.syncLocalThread>[0]["payload"],
    ) =>
      teamService.syncLocalThread({
        sessionId,
        payload,
        ...(deps?.eventSink !== undefined ? { eventSink: deps.eventSink } : {}),
        ...(deps?.projectionStore !== undefined ? { projectionStore: deps.projectionStore } : {}),
      }),
    [TEAM_WS_METHODS.teamCreateThreadNote]: (
      payload: Parameters<typeof teamService.createThreadNote>[0]["payload"],
    ) => teamService.createThreadNote({ sessionId, payload }),
    [TEAM_WS_METHODS.teamDeleteThreadNote]: (
      payload: Parameters<typeof teamService.deleteThreadNote>[0]["payload"],
    ) => teamService.deleteThreadNote({ sessionId, payload }),
    [TEAM_WS_METHODS.teamResolveThreadNote]: (
      payload: Parameters<typeof teamService.resolveThreadNote>[0]["payload"],
    ) => teamService.resolveThreadNote({ sessionId, payload }),
    [TEAM_WS_METHODS.teamEditThreadNote]: (
      payload: Parameters<typeof teamService.editThreadNote>[0]["payload"],
    ) => teamService.editThreadNote({ sessionId, payload }),
    [TEAM_WS_METHODS.teamReserveAcceptedNotes]: (
      payload: Parameters<typeof teamService.reserveAcceptedNotes>[0]["payload"],
    ) => teamService.reserveAcceptedNotes({ sessionId, payload }),
    [TEAM_WS_METHODS.teamReleaseAcceptedNotes]: (
      payload: Parameters<typeof teamService.releaseAcceptedNotes>[0]["payload"],
    ) => teamService.releaseAcceptedNotes({ sessionId, payload }),
    [TEAM_WS_METHODS.teamConsumeAcceptedNotes]: (
      payload: Parameters<typeof teamService.consumeAcceptedNotes>[0]["payload"],
    ) => teamService.consumeAcceptedNotes({ sessionId, payload }),
    [TEAM_WS_METHODS.teamListThreadNotes]: (
      payload: Parameters<typeof teamService.listThreadNotes>[0]["payload"],
    ) =>
      teamService.listThreadNotes({ sessionId, payload }).pipe(Effect.map((notes) => ({ notes }))),
    [TEAM_WS_METHODS.teamUpsertProvider]: (
      payload: Parameters<typeof teamService.upsertProvider>[0]["payload"],
    ) => teamService.upsertProvider({ sessionId, payload }),
    [TEAM_WS_METHODS.teamDeleteProvider]: (
      payload: Parameters<typeof teamService.deleteProvider>[0]["payload"],
    ) => teamService.deleteProvider({ sessionId, payload }),
    [TEAM_WS_METHODS.teamListProviderUsage]: () =>
      teamService.listProviderUsage(sessionId).pipe(Effect.map((usage) => ({ usage }))),
    [TEAM_WS_METHODS.teamUpsertSkill]: (
      payload: Parameters<typeof teamService.upsertSkill>[0]["payload"],
    ) => teamService.upsertSkill({ sessionId, payload }),
    [TEAM_WS_METHODS.teamDeleteSkill]: (
      payload: Parameters<typeof teamService.deleteSkill>[0]["payload"],
    ) => teamService.deleteSkill({ sessionId, payload }),
    [TEAM_WS_METHODS.teamUpsertPreprompt]: (
      payload: Parameters<typeof teamService.upsertPreprompt>[0]["payload"],
    ) => teamService.upsertPreprompt({ sessionId, payload }),
    [TEAM_WS_METHODS.teamDeletePreprompt]: (
      payload: Parameters<typeof teamService.deletePreprompt>[0]["payload"],
    ) => teamService.deletePreprompt({ sessionId, payload }),
    [TEAM_WS_METHODS.teamIssueLocalSyncToken]: () => teamService.issueLocalSyncToken(sessionId),
    [TEAM_WS_METHODS.teamSyncLocalBinding]: (
      payload: Parameters<
        TeamProviderManager.TeamProviderManager["Service"]["syncLocalTeamBinding"]
      >[0],
    ) =>
      teamService.assertLocalBindingHostAllowed().pipe(
        Effect.andThen(
          deps?.teamProviderManager !== undefined
            ? deps.teamProviderManager.syncLocalTeamBinding(payload)
            : Effect.succeed({
                synced: false,
                virtualInstanceIds: [],
                assetsRevision: NonNegativeInt.make(0),
              }),
        ),
      ),
    [TEAM_WS_METHODS.teamRemoveLocalBinding]: (payload: {
      readonly teamId: Parameters<
        TeamProviderManager.TeamProviderManager["Service"]["removeLocalTeamBinding"]
      >[0];
    }) =>
      teamService
        .assertLocalBindingHostAllowed()
        .pipe(
          Effect.andThen(
            deps?.teamProviderManager !== undefined
              ? deps.teamProviderManager
                  .removeLocalTeamBinding(payload.teamId)
                  .pipe(Effect.map((removed) => ({ removed })))
              : Effect.succeed({ removed: false }),
          ),
        ),
    [TEAM_WS_METHODS.teamNotifyLocalAssetsUpdated]: (payload: {
      readonly teamId: Parameters<
        TeamProviderManager.TeamProviderManager["Service"]["syncLocalAssetsDelta"]
      >[0];
      readonly revision: number;
    }) =>
      teamService.assertLocalBindingHostAllowed().pipe(
        Effect.andThen(
          deps?.teamProviderManager !== undefined
            ? deps.teamProviderManager
                .syncLocalAssetsDelta(payload.teamId, { targetRevision: payload.revision })
                .pipe(
                  Effect.map((syncedRevision) => ({
                    syncedRevision: NonNegativeInt.make(Math.max(0, syncedRevision)),
                  })),
                  Effect.orElseSucceed(() => ({ syncedRevision: NonNegativeInt.make(0) })),
                )
            : Effect.succeed({ syncedRevision: NonNegativeInt.make(0) }),
        ),
      ),
    [TEAM_WS_METHODS.teamUpdateMyMobileVisibility]: (
      payload: Parameters<typeof teamService.updateMyMobileVisibility>[0]["payload"],
    ) => teamService.updateMyMobileVisibility({ sessionId, payload }),
    [TEAM_WS_METHODS.teamCreateMobilePairingLink]: (
      payload: Parameters<typeof teamService.createMobilePairingLink>[0]["payload"],
    ) =>
      teamService.createMobilePairingLink({
        sessionId,
        callerScopes: deps?.callerScopes ?? [],
        payload,
        ...(deps?.serverAuth !== undefined ? { serverAuth: deps.serverAuth } : {}),
      }),
    [TEAM_WS_METHODS.teamListMyMobilePairingLinks]: () =>
      teamService
        .listMyMobilePairingLinks({
          sessionId,
          ...(deps?.serverAuth !== undefined ? { serverAuth: deps.serverAuth } : {}),
        })
        .pipe(Effect.map((pairingLinks) => ({ pairingLinks }))),
    [TEAM_WS_METHODS.teamRevokeMyMobilePairingLink]: (
      payload: Parameters<typeof teamService.revokeMyMobilePairingLink>[0]["payload"],
    ) =>
      teamService.revokeMyMobilePairingLink({
        sessionId,
        payload,
        ...(deps?.serverAuth !== undefined ? { serverAuth: deps.serverAuth } : {}),
      }),
    [TEAM_WS_METHODS.teamConnectMyGitHub]: (
      payload: Parameters<typeof teamService.connectMyGitHub>[0]["payload"],
    ) => teamService.connectMyGitHub({ sessionId, payload }),
    [TEAM_WS_METHODS.teamDisconnectMyGitHub]: () => teamService.disconnectMyGitHub({ sessionId }),
    [TEAM_WS_METHODS.teamSetAutomationGitHub]: (
      payload: Parameters<typeof teamService.setAutomationGitHub>[0]["payload"],
    ) => teamService.setAutomationGitHub({ sessionId, payload }),
    [TEAM_WS_METHODS.teamClearAutomationGitHub]: () =>
      teamService.clearAutomationGitHub({ sessionId }),
    [TEAM_WS_METHODS.teamSetGitHubAppConfig]: (
      payload: Parameters<typeof teamService.setGitHubAppConfig>[0]["payload"],
    ) => teamService.setGitHubAppConfig({ sessionId, payload }),
    [TEAM_WS_METHODS.teamClearGitHubAppConfig]: () =>
      teamService.clearGitHubAppConfig({ sessionId }),
    [TEAM_WS_METHODS.teamStartGitHubOAuth]: (
      payload: Parameters<typeof teamService.startGitHubOAuth>[0]["payload"],
    ) => teamService.startGitHubOAuth({ sessionId, payload }),
    [TEAM_WS_METHODS.teamCompleteGitHubOAuth]: (
      payload: Parameters<typeof teamService.completeGitHubOAuth>[0]["payload"],
    ) => teamService.completeGitHubOAuth({ sessionId, payload }),
    [TEAM_WS_METHODS.teamStartGitHubDeviceFlow]: (
      payload: Parameters<typeof teamService.startGitHubDeviceFlow>[0]["payload"],
    ) => teamService.startGitHubDeviceFlow({ sessionId, payload }),
    [TEAM_WS_METHODS.teamPollGitHubDeviceFlow]: (
      payload: Parameters<typeof teamService.pollGitHubDeviceFlow>[0]["payload"],
    ) => teamService.pollGitHubDeviceFlow({ sessionId, payload }),
    [TEAM_WS_METHODS.teamCancelGitHubDeviceFlow]: (
      payload: Parameters<typeof teamService.cancelGitHubDeviceFlow>[0]["payload"],
    ) => teamService.cancelGitHubDeviceFlow({ sessionId, payload }),
  };
}

/**
 * Stamps server-authoritative `creatorMemberId` and `authorMemberId` from stored orchestration
 * events after a WebSocket command commits. Records both run-level (`run.created`) and prompt-level
 * (`message.updated` for user messages, covering steering prompts within an active run) attribution.
 * Short-circuits as a no-op in personal mode.
 */
export const recordTeamDispatchEvents = (
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
  storedEvents: ReadonlyArray<{ readonly event: OrchestrationV2DomainEvent }>,
  command?: OrchestrationV2Command,
  noteReservationToken?: string | null,
  activeRunIdBeforeDispatch?: string | null,
) =>
  Effect.forEach(
    storedEvents,
    ({ event }) => {
      if (event.type === "thread.created") {
        return teamService.recordThreadCreated({
          sessionId,
          threadId: event.payload.id,
          projectId: event.payload.projectId,
        });
      }
      if (event.type === "run.created") {
        return teamService.recordTurnAuthored({
          sessionId,
          threadId: event.payload.threadId,
          turnId: event.payload.id,
        });
      }
      if (event.type === "message.updated" && event.payload.role === "user") {
        return teamService.recordTurnAuthored({
          sessionId,
          threadId: event.payload.threadId,
          turnId: `msg:${event.payload.id}`,
        });
      }
      return Effect.void;
    },
    { discard: true },
  ).pipe(
    Effect.andThen(() => {
      if (typeof teamService.notifyQueuedMessage !== "function") {
        return Effect.void;
      }
      const queuedRunEntry = storedEvents.find(
        ({ event }) => event.type === "run.created" && event.payload.status === "queued",
      );
      if (!queuedRunEntry || queuedRunEntry.event.type !== "run.created") {
        return Effect.void;
      }
      const queuedRun = queuedRunEntry.event.payload;
      const userMessageEntry = storedEvents.find(
        ({ event }) => event.type === "message.updated" && event.payload.role === "user",
      );
      const messageText =
        userMessageEntry && userMessageEntry.event.type === "message.updated"
          ? userMessageEntry.event.payload.text
          : command?.type === "message.dispatch"
            ? command.text
            : "";
      return teamService
        .notifyQueuedMessage({
          actor: { kind: "session", sessionId },
          threadId: queuedRun.threadId,
          queuedRunId: queuedRun.id,
          ...(command !== undefined ? { commandId: command.commandId } : {}),
          ...(activeRunIdBeforeDispatch != null ? { activeRunId: activeRunIdBeforeDispatch } : {}),
          messageText,
        })
        .pipe(Effect.asVoid);
    }),
    Effect.andThen(
      command?.type === "message.dispatch"
        ? (() => {
            const createdRun = storedEvents.find(({ event }) => event.type === "run.created");
            const targetTurnId =
              createdRun && createdRun.event.type === "run.created"
                ? createdRun.event.payload.id
                : `msg:${command.messageId}`;
            return teamService.finalizeNotesForDispatchedTurn({
              sessionId,
              threadId: command.threadId,
              targetTurnId,
              acceptedNotes: command.teamAcceptedNotes ?? [],
              reservationToken: noteReservationToken ?? null,
            });
          })()
        : Effect.void,
    ),
  );

/**
 * Stamps server-authoritative `creatorMemberId` and initial run/prompt `authorMemberId` after
 * `orchestration.launchThread` commits. Short-circuits as a no-op in personal mode.
 */
export const recordTeamThreadLaunch = (
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
  result: Pick<ThreadLaunchResult, "threadId" | "projection" | "resumed">,
  options?: {
    readonly projectId?: ProjectId;
    readonly viewId?: TeamViewId;
    readonly locked?: boolean;
  },
) => {
  if (result.resumed) return Effect.void;
  const runIds = result.projection.runs.map((run) => run.id);
  const userMessageTurnIds = result.projection.messages
    .filter((message) => message.role === "user")
    .map((message) => `msg:${message.id}`);
  const turnIds = [...runIds, ...userMessageTurnIds];
  return teamService
    .recordThreadCreated({
      sessionId,
      threadId: result.threadId,
      ...(options?.projectId !== undefined ? { projectId: options.projectId } : {}),
      ...(options?.viewId !== undefined ? { viewId: options.viewId } : {}),
      ...(options?.locked !== undefined ? { locked: options.locked } : {}),
    })
    .pipe(
      Effect.andThen(
        Effect.forEach(
          turnIds,
          (turnId) =>
            teamService.recordTurnAuthored({
              sessionId,
              threadId: result.threadId,
              turnId,
            }),
          { discard: true },
        ),
      ),
    );
};

export const filterShellSnapshotForSession = Effect.fn("TeamWsHandlers.filterShellSnapshot")(
  function* (
    teamService: TeamService.TeamService["Service"],
    sessionId: AuthSessionId,
    snapshot: OrchestrationV2ShellSnapshot,
    options?: { readonly upstreamCompat?: boolean },
  ) {
    if (options?.upstreamCompat === true) {
      return yield* adaptShellSnapshotForUpstreamCompat(teamService, sessionId, snapshot, true);
    }
    if (!(yield* teamService.isTeamConfigured())) {
      return snapshot;
    }
    const allIds = [
      ...snapshot.threads.map((thread) => thread.id),
      ...snapshot.archivedThreads.map((thread) => thread.id),
    ];
    const readableIds = yield* teamService.filterReadableThreadIds(sessionId, allIds);
    return {
      ...snapshot,
      threads: snapshot.threads.filter((thread) => readableIds.has(thread.id)),
      archivedThreads: snapshot.archivedThreads.filter((thread) => readableIds.has(thread.id)),
    };
  },
);

const filterShellStreamItemForSession = Effect.fn("TeamWsHandlers.filterShellStreamItem")(
  function* (
    teamService: TeamService.TeamService["Service"],
    sessionId: AuthSessionId,
    item: OrchestrationV2ShellStreamItem,
    options?: { readonly upstreamCompat?: boolean },
  ): Effect.fn.Return<OrchestrationV2ShellStreamItem | null> {
    if (options?.upstreamCompat === true) {
      return yield* adaptShellStreamItemForUpstreamCompat(teamService, sessionId, item, true);
    }
    if (item.kind === "snapshot") {
      if (item.snapshot.threads.length === 0 && item.snapshot.archivedThreads.length === 0) {
        return item;
      }
      const filtered = yield* filterShellSnapshotForSession(teamService, sessionId, item.snapshot);
      return { ...item, snapshot: filtered };
    }
    if (item.kind === "thread.updated") {
      const readable = yield* teamService.canReadThread(sessionId, item.thread.id);
      return readable ? item : null;
    }
    if (item.kind === "thread.removed") {
      const readable = yield* teamService.canReadThread(sessionId, item.threadId);
      return readable ? item : null;
    }
    return item;
  },
);

export const filterSearchThreadsResultForSession = Effect.fn(
  "TeamWsHandlers.filterSearchThreadsResult",
)(function* (
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
  result: OrchestrationV2SearchThreadsResult,
  options?: { readonly upstreamCompat?: boolean },
) {
  if (!(yield* teamService.isTeamConfigured())) {
    return result;
  }
  const allIds = [
    ...result.matches.map((match) => match.threadId),
    ...(result.threads ?? []).map((thread) => thread.id),
  ];
  const readableIds = yield* teamService.filterReadableThreadIds(sessionId, allIds);
  const filtered: OrchestrationV2SearchThreadsResult = {
    ...result,
    matches: result.matches.filter((match) => readableIds.has(match.threadId)),
    ...(result.threads === undefined
      ? {}
      : { threads: result.threads.filter((thread) => readableIds.has(thread.id)) }),
  };
  return options?.upstreamCompat === true
    ? yield* adaptSearchThreadsResultForUpstreamCompat(teamService, filtered, true)
    : filtered;
});

export const filterThreadTitlesForSession = Effect.fn("TeamWsHandlers.filterThreadTitles")(
  function* (
    teamService: TeamService.TeamService["Service"],
    sessionId: AuthSessionId,
    titles: Readonly<Record<ThreadId, string>>,
    options?: { readonly upstreamCompat?: boolean },
  ): Effect.fn.Return<Record<ThreadId, string>> {
    const filtered = yield* filterThreadRecordByReadableIds(teamService, sessionId, titles);
    return options?.upstreamCompat === true
      ? yield* adaptThreadTitlesForUpstreamCompat(teamService, filtered, true)
      : filtered;
  },
);

export const filterThreadLinkMetadataForSession = Effect.fn(
  "TeamWsHandlers.filterThreadLinkMetadata",
)(function* (
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
  metadata: Readonly<Record<ThreadId, OrchestrationV2ThreadLinkMetadata>>,
  options?: { readonly upstreamCompat?: boolean },
): Effect.fn.Return<Record<ThreadId, OrchestrationV2ThreadLinkMetadata>> {
  const filtered = yield* filterThreadRecordByReadableIds(teamService, sessionId, metadata);
  return options?.upstreamCompat === true
    ? yield* adaptThreadLinkMetadataForUpstreamCompat(teamService, filtered, true)
    : filtered;
});

export const adaptThreadStreamForSession = <E, R>(
  teamService: TeamService.TeamService["Service"],
  stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>,
  options?: { readonly upstreamCompat?: boolean },
): Stream.Stream<OrchestrationV2ThreadStreamItem, E, R> =>
  options?.upstreamCompat === true
    ? stream.pipe(
        Stream.mapEffect((item) => adaptThreadStreamItemForUpstreamCompat(teamService, item, true)),
      )
    : stream;

export const filterThreadRecordByReadableIds = Effect.fn(
  "TeamWsHandlers.filterThreadRecordByReadableIds",
)(function* <T>(
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
  record: Readonly<Record<ThreadId, T>>,
): Effect.fn.Return<Record<ThreadId, T>> {
  const keys = Object.keys(record) as Array<ThreadId>;
  if (keys.length === 0 || !(yield* teamService.isTeamConfigured())) {
    return { ...record };
  }
  const readableIds = yield* teamService.filterReadableThreadIds(sessionId, keys);
  const filtered = {} as Record<ThreadId, T>;
  for (const key of keys) {
    if (readableIds.has(key)) {
      filtered[key] = record[key]!;
    }
  }
  return filtered;
});

export const assertCanReadAssetResource = (
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
  resource: AssetResource,
): Effect.Effect<void, EnvironmentAuthorizationError> => {
  switch (resource._tag) {
    case "workspace-file":
    case "media-file":
    case "tool-output-image":
      return teamService.assertCanReadThread(sessionId, resource.threadId);
    case "attachment":
      return teamService.assertCanReadAttachment(sessionId, resource.attachmentId);
    default:
      return Effect.void;
  }
};

export const prepareTeamDispatchAttribution = (
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
  command: OrchestrationV2Command,
): Effect.Effect<ThreadId | null, EnvironmentAuthorizationError> => {
  if (command.type === "thread.create") {
    return teamService
      .prepareThreadAttribution({
        sessionId,
        threadId: command.threadId,
        projectId: command.projectId,
      })
      .pipe(Effect.map((prepared) => (prepared ? command.threadId : null)));
  }
  if (command.type === "thread.fork") {
    return teamService
      .prepareThreadInheritedFromParent({
        parentThreadId: command.sourceThreadId,
        threadId: command.targetThreadId,
        creatorSessionId: sessionId,
      })
      .pipe(Effect.map((prepared) => (prepared ? command.targetThreadId : null)));
  }
  if (command.type === "delegated_task.request") {
    const childThreadId = deriveOrchestrationId.delegatedTaskThread({
      commandId: command.commandId,
    });
    return teamService
      .prepareThreadInheritedFromParent({
        parentThreadId: command.parentThreadId,
        threadId: childThreadId,
        creatorSessionId: sessionId,
      })
      .pipe(Effect.map((prepared) => (prepared ? childThreadId : null)));
  }
  return Effect.succeed(null);
};

export const filterTerminalMetadataStreamForSession = <E, R>(
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
  stream: Stream.Stream<TerminalMetadataStreamEvent, E, R>,
): Stream.Stream<TerminalMetadataStreamEvent, E, R> =>
  stream.pipe(
    Stream.mapEffect((event) =>
      Effect.gen(function* () {
        if (!(yield* teamService.isTeamConfigured())) {
          return event;
        }
        if (event.type === "snapshot") {
          if (event.terminals.length === 0) return event;
          const readableIds = yield* teamService.filterReadableThreadIds(
            sessionId,
            event.terminals.map((terminal) => ThreadId.make(terminal.threadId)),
          );
          return {
            ...event,
            terminals: event.terminals.filter((terminal) =>
              readableIds.has(ThreadId.make(terminal.threadId)),
            ),
          } satisfies TerminalMetadataStreamEvent;
        }
        const threadId =
          event.type === "upsert"
            ? ThreadId.make(event.terminal.threadId)
            : ThreadId.make(event.threadId);
        const readable = yield* teamService.canReadThread(sessionId, threadId);
        return readable ? event : null;
      }),
    ),
    Stream.filter((event): event is TerminalMetadataStreamEvent => event !== null),
  );

export const filterPreviewEventsStreamForSession = <E, R>(
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
  stream: Stream.Stream<PreviewEvent, E, R>,
): Stream.Stream<PreviewEvent, E, R> =>
  stream.pipe(
    Stream.mapEffect((event) =>
      Effect.gen(function* () {
        if (!(yield* teamService.isTeamConfigured())) {
          return event;
        }
        const readable = yield* teamService.canReadThread(sessionId, ThreadId.make(event.threadId));
        return readable ? event : null;
      }),
    ),
    Stream.filter((event): event is PreviewEvent => event !== null),
  );

export const filterDeviceStateForSession = Effect.fn("TeamWsHandlers.filterDeviceState")(function* (
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
  state: DeviceServiceState,
): Effect.fn.Return<DeviceServiceState> {
  if (!(yield* teamService.isTeamConfigured())) {
    return state;
  }
  const threadIds = [
    ...state.sessions.map((session) => session.threadId),
    ...(state.bootingDevices ?? []).map((device) => device.threadId),
  ];
  if (threadIds.length === 0) {
    return state;
  }
  const readableIds = yield* teamService.filterReadableThreadIds(sessionId, threadIds);
  return {
    ...state,
    sessions: state.sessions.filter((session) => readableIds.has(session.threadId)),
    ...(state.bootingDevices === undefined
      ? {}
      : {
          bootingDevices: state.bootingDevices.filter((device) => readableIds.has(device.threadId)),
        }),
  };
});

/**
 * Guards any thread-scoped stream (`subscribeThread`, `subscribeCommandOutput`,
 * `subscribePromptSuggestion`, `searchThreadStream`, `subscribeWorktreeSetup`, `terminalAttach`,
 * `terminalObserve`) against live access revocation. Subscribes to team access changes before the
 * initial authorization check so revocations racing with stream bootstrap are never missed.
 */
export const guardThreadScopedStreamForSession = <A, E, R>(
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
  threadId: ThreadId,
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const accessChanges = yield* teamService.openAccessChangeSubscription();
      yield* teamService.assertCanReadThread(sessionId, threadId);
      const revocationStream: Stream.Stream<never, EnvironmentAuthorizationError> =
        accessChanges.pipe(
          Stream.mapEffect((change) => {
            if (
              change.type === "memberVisibility" ||
              change.type === "memberFollow" ||
              change.type === "memberPseudo" ||
              (change.type === "threadView" && change.threadId !== threadId)
            ) {
              return Effect.void;
            }
            return teamService.assertCanReadThread(sessionId, threadId);
          }),
          Stream.filter(() => false),
        ) as Stream.Stream<never, EnvironmentAuthorizationError>;
      return Stream.merge(stream, revocationStream, { haltStrategy: "either" });
    }),
  );

/**
 * Merges live team access-change snapshots into `subscribeShell` so moving a thread to a narrower
 * View or changing view/role rules immediately drops unauthorized threads from connected clients.
 */
export const withTeamShellAccessUpdates = <E, R>(
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
  loadFilteredSnapshot: () => Effect.Effect<OrchestrationV2ShellSnapshot, E, R>,
  stream: Stream.Stream<OrchestrationV2ShellStreamItem, E, R>,
  options?: { readonly upstreamCompat?: boolean },
): Stream.Stream<OrchestrationV2ShellStreamItem, E, R> => {
  const filteredStream = stream.pipe(
    Stream.mapEffect((item) =>
      filterShellStreamItemForSession(teamService, sessionId, item, options),
    ),
    Stream.filter((item): item is OrchestrationV2ShellStreamItem => item !== null),
  );
  const accessSnapshots: Stream.Stream<OrchestrationV2ShellStreamItem, E, R> = teamService
    .subscribeAccessChanges()
    .pipe(
      Stream.filterEffect((change) =>
        typeof teamService.shouldRefreshShellForAccessChange === "function"
          ? teamService.shouldRefreshShellForAccessChange(sessionId, change, options)
          : Effect.succeed(true),
      ),
      Stream.mapEffect(() =>
        loadFilteredSnapshot().pipe(
          Effect.map((snapshot): OrchestrationV2ShellStreamItem => ({
            kind: "snapshot",
            snapshot,
          })),
        ),
      ),
    );
  return Stream.merge(filteredStream, accessSnapshots, { haltStrategy: "left" });
};
