import {
  TEAM_WS_METHODS,
  ThreadId,
  type AssetResource,
  type AuthSessionId,
  type EnvironmentAuthorizationError,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2SearchThreadsResult,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type PreviewEvent,
  type TeamViewId,
  type TerminalMetadataStreamEvent,
} from "@t3tools/contracts";
import { derive as deriveOrchestrationId } from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ThreadLaunchResult } from "../orchestration-v2/ThreadLaunchService.ts";
import * as TeamService from "./TeamService.ts";

export function makeTeamWsRpcHandlers(
  teamService: TeamService.TeamService["Service"],
  sessionId: AuthSessionId,
) {
  return {
    [TEAM_WS_METHODS.teamGetState]: () => teamService.getState(sessionId),
    [TEAM_WS_METHODS.teamSubscribeState]: () => teamService.streamState(sessionId),
    [TEAM_WS_METHODS.teamInitialize]: (
      payload: Parameters<typeof teamService.initializeTeam>[0]["payload"],
    ) => teamService.initializeTeam({ sessionId, payload }),
    [TEAM_WS_METHODS.teamUpdateMyPseudo]: (
      payload: Parameters<typeof teamService.updateMyPseudo>[0]["payload"],
    ) => teamService.updateMyPseudo({ sessionId, payload }),
    [TEAM_WS_METHODS.teamUpdateMemberRole]: (
      payload: Parameters<typeof teamService.updateMemberRole>[0]["payload"],
    ) => teamService.updateMemberRole({ sessionId, payload }),
    [TEAM_WS_METHODS.teamUpdateMemberStatus]: (
      payload: Parameters<typeof teamService.updateMemberStatus>[0]["payload"],
    ) => teamService.updateMemberStatus({ sessionId, payload }),
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
) =>
  Effect.forEach(
    storedEvents,
    ({ event }) => {
      if (event.type === "thread.created") {
        return teamService.recordThreadCreated({ sessionId, threadId: event.payload.id });
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
  ) {
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
  ): Effect.fn.Return<OrchestrationV2ShellStreamItem | null> {
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
) {
  if (!(yield* teamService.isTeamConfigured())) {
    return result;
  }
  const allIds = [
    ...result.matches.map((match) => match.threadId),
    ...(result.threads ?? []).map((thread) => thread.id),
  ];
  const readableIds = yield* teamService.filterReadableThreadIds(sessionId, allIds);
  return {
    ...result,
    matches: result.matches.filter((match) => readableIds.has(match.threadId)),
    ...(result.threads === undefined
      ? {}
      : { threads: result.threads.filter((thread) => readableIds.has(thread.id)) }),
  };
});

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
            if (change.type === "threadView" && change.threadId !== threadId) {
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
): Stream.Stream<OrchestrationV2ShellStreamItem, E, R> => {
  const filteredStream = stream.pipe(
    Stream.mapEffect((item) => filterShellStreamItemForSession(teamService, sessionId, item)),
    Stream.filter((item): item is OrchestrationV2ShellStreamItem => item !== null),
  );
  const accessSnapshots: Stream.Stream<OrchestrationV2ShellStreamItem, E, R> = teamService
    .subscribeAccessChanges()
    .pipe(
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
