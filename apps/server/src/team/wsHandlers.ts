import {
  TEAM_WS_METHODS,
  type AuthSessionId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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
    [TEAM_WS_METHODS.teamCreateInvite]: (
      payload: Parameters<typeof teamService.createInvite>[0]["payload"],
    ) => teamService.createInvite({ sessionId, payload }),
    [TEAM_WS_METHODS.teamRevokeInvite]: (
      payload: Parameters<typeof teamService.revokeInvite>[0]["payload"],
    ) => teamService.revokeInvite({ sessionId, payload }),
    [TEAM_WS_METHODS.teamListThreadAttributions]: () =>
      teamService.listThreadAttributions().pipe(Effect.map((attributions) => ({ attributions }))),
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
) => {
  if (result.resumed) return Effect.void;
  const runIds = result.projection.runs.map((run) => run.id);
  const userMessageTurnIds = result.projection.messages
    .filter((message) => message.role === "user")
    .map((message) => `msg:${message.id}`);
  const turnIds = [...runIds, ...userMessageTurnIds];
  return teamService.recordThreadCreated({ sessionId, threadId: result.threadId }).pipe(
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
