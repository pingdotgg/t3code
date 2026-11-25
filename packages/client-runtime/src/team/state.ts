import {
  EnvironmentHttpApi,
  TEAM_WS_METHODS,
  type EnvironmentId,
  type TeamInvite,
  type TeamMember,
  type TeamMemberId,
  type TeamStateSnapshot,
  type TeamStateStreamEvent,
  type TeamThreadAttribution,
  type TeamTurnAttribution,
  type TeamWorkspace,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  DpopConnectionCredential,
} from "../connection/catalog.ts";
import { mapRemoteEnvironmentError } from "../connection/errors.ts";
import { BearerConnectionTarget, ConnectionBlockedError } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import {
  deriveWsBaseUrl,
  environmentEndpointUrl,
  normalizeHttpBaseUrl,
} from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { subscribe } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, followStreamInEnvironment } from "../state/runtime.ts";

export interface TeamEnvironmentState {
  readonly team: TeamWorkspace | null;
  readonly currentMember: TeamMember | null;
  readonly members: ReadonlyArray<TeamMember>;
  readonly invites: ReadonlyArray<TeamInvite>;
  readonly threadAttributions: ReadonlyArray<TeamThreadAttribution>;
  readonly followedThreadIds: ReadonlySet<ThreadId>;
  readonly latestTurnByThreadId: ReadonlyMap<ThreadId, TeamTurnAttribution>;
  readonly turnAuthorByTurnId: ReadonlyMap<string, TeamTurnAttribution>;
  readonly memberById: ReadonlyMap<TeamMemberId, TeamMember>;
  readonly attributionByThreadId: ReadonlyMap<ThreadId, TeamThreadAttribution>;
}

export const EMPTY_TEAM_ENVIRONMENT_STATE: TeamEnvironmentState = {
  team: null,
  currentMember: null,
  members: [],
  invites: [],
  threadAttributions: [],
  followedThreadIds: new Set(),
  latestTurnByThreadId: new Map(),
  turnAuthorByTurnId: new Map(),
  memberById: new Map(),
  attributionByThreadId: new Map(),
};

function buildStateFromSnapshot(snapshot: TeamStateSnapshot): TeamEnvironmentState {
  const memberById = new Map<TeamMemberId, TeamMember>(
    snapshot.members.map((member) => [member.id, member] as const),
  );
  const attributionByThreadId = new Map<ThreadId, TeamThreadAttribution>(
    snapshot.threadAttributions.map((attribution) => [attribution.threadId, attribution] as const),
  );
  const followedThreadIds = new Set<ThreadId>(snapshot.followedThreadIds);
  const latestTurnByThreadId = new Map<ThreadId, TeamTurnAttribution>();
  const turnAuthorByTurnId = new Map<string, TeamTurnAttribution>();
  for (const turn of snapshot.latestTurnAttributions) {
    turnAuthorByTurnId.set(turn.turnId, turn);
    if (!latestTurnByThreadId.has(turn.threadId)) {
      latestTurnByThreadId.set(turn.threadId, turn);
    }
  }
  return {
    team: snapshot.team,
    currentMember: snapshot.currentMember,
    members: snapshot.members,
    invites: snapshot.invites,
    threadAttributions: snapshot.threadAttributions,
    followedThreadIds,
    latestTurnByThreadId,
    turnAuthorByTurnId,
    memberById,
    attributionByThreadId,
  };
}

export function applyTeamStreamEvent(
  current: TeamEnvironmentState,
  event: TeamStateStreamEvent,
): TeamEnvironmentState {
  switch (event.type) {
    case "snapshot":
      return buildStateFromSnapshot(event.payload);

    case "teamUpdated":
      return { ...current, team: event.payload };

    case "memberUpserted": {
      const member = event.payload;
      const memberById = new Map(current.memberById);
      memberById.set(member.id, member);
      const members = [...memberById.values()];
      const currentMember =
        current.currentMember?.id === member.id ? member : current.currentMember;
      // Keep cached creatorPseudo in thread attributions synchronized when a member changes pseudo.
      const attributionByThreadId = new Map(current.attributionByThreadId);
      let attributionsChanged = false;
      for (const [threadId, attribution] of attributionByThreadId) {
        if (
          attribution.creatorMemberId === member.id &&
          attribution.creatorPseudo !== member.pseudo
        ) {
          attributionByThreadId.set(threadId, { ...attribution, creatorPseudo: member.pseudo });
          attributionsChanged = true;
        }
      }
      const latestTurnByThreadId = new Map(current.latestTurnByThreadId);
      const turnAuthorByTurnId = new Map(current.turnAuthorByTurnId);
      let turnsChanged = false;
      for (const [threadId, turn] of latestTurnByThreadId) {
        if (turn.authorMemberId === member.id && turn.authorPseudo !== member.pseudo) {
          latestTurnByThreadId.set(threadId, { ...turn, authorPseudo: member.pseudo });
          turnsChanged = true;
        }
      }
      for (const [turnId, turn] of turnAuthorByTurnId) {
        if (turn.authorMemberId === member.id && turn.authorPseudo !== member.pseudo) {
          turnAuthorByTurnId.set(turnId, { ...turn, authorPseudo: member.pseudo });
          turnsChanged = true;
        }
      }
      return {
        ...current,
        currentMember,
        members,
        memberById,
        ...(attributionsChanged
          ? {
              threadAttributions: [...attributionByThreadId.values()],
              attributionByThreadId,
            }
          : {}),
        ...(turnsChanged ? { latestTurnByThreadId, turnAuthorByTurnId } : {}),
      };
    }

    case "inviteUpserted": {
      const invite = event.payload;
      const index = current.invites.findIndex((existing) => existing.id === invite.id);
      const invites =
        index === -1
          ? [invite, ...current.invites]
          : current.invites.map((existing, i) => (i === index ? invite : existing));
      return { ...current, invites };
    }

    case "threadAttributed": {
      const attribution = event.payload;
      const attributionByThreadId = new Map(current.attributionByThreadId);
      attributionByThreadId.set(attribution.threadId, attribution);
      return {
        ...current,
        threadAttributions: [...attributionByThreadId.values()],
        attributionByThreadId,
      };
    }

    case "turnAttributed": {
      const turn = event.payload;
      const latestTurnByThreadId = new Map(current.latestTurnByThreadId);
      latestTurnByThreadId.set(turn.threadId, turn);
      const turnAuthorByTurnId = new Map(current.turnAuthorByTurnId);
      turnAuthorByTurnId.set(turn.turnId, turn);
      return {
        ...current,
        latestTurnByThreadId,
        turnAuthorByTurnId,
      };
    }

    case "threadFollowChanged": {
      const change = event.payload;
      if (current.currentMember?.id !== change.memberId) {
        return current;
      }
      const followedThreadIds = new Set(current.followedThreadIds);
      if (change.isFollowing) {
        followedThreadIds.add(change.threadId);
      } else {
        followedThreadIds.delete(change.threadId);
      }
      return {
        ...current,
        followedThreadIds,
      };
    }
  }
}

export function createTeamEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const state = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        followStreamInEnvironment(
          environmentId,
          Stream.suspend(() =>
            subscribe(TEAM_WS_METHODS.teamSubscribeState, {}).pipe(
              Stream.scan(() => EMPTY_TEAM_ENVIRONMENT_STATE, applyTeamStreamEvent),
            ),
          ),
        ),
      )
      .pipe(Atom.withLabel(`environment-data:team:state:${environmentId}`)),
  );

  return {
    state,
    initialize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:initialize",
      tag: TEAM_WS_METHODS.teamInitialize,
    }),
    updateMyPseudo: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:update-my-pseudo",
      tag: TEAM_WS_METHODS.teamUpdateMyPseudo,
    }),
    createInvite: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:create-invite",
      tag: TEAM_WS_METHODS.teamCreateInvite,
    }),
    revokeInvite: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:revoke-invite",
      tag: TEAM_WS_METHODS.teamRevokeInvite,
    }),
    followThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:follow-thread",
      tag: TEAM_WS_METHODS.teamFollowThread,
    }),
    unfollowThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:unfollow-thread",
      tag: TEAM_WS_METHODS.teamUnfollowThread,
    }),
  };
}

export interface TeamInvitePreviewInput {
  readonly serverUrl: string;
  readonly token: string;
}

export interface TeamInviteJoinInput {
  readonly serverUrl: string;
  readonly token: string;
  readonly pseudo: string;
}

export interface TeamInviteJoinResult {
  readonly environmentId: EnvironmentId;
  readonly team: TeamWorkspace;
  readonly member: TeamMember;
}

const normalizeTeamServerUrl = (serverUrl: string) =>
  Effect.try({
    try: () => normalizeHttpBaseUrl(serverUrl),
    catch: () =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: "The team server URL is invalid.",
      }),
  });

export const previewTeamInviteEffect = Effect.fn("clientRuntime.team.previewInvite")(function* (
  input: TeamInvitePreviewInput,
) {
  const httpBaseUrl = yield* normalizeTeamServerUrl(input.serverUrl);
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: httpBaseUrl });
  return yield* client.team.previewInvite({
    payload: { token: input.token.trim() },
  });
});

function teamBearerConnectionId(environmentId: EnvironmentId, httpBaseUrl: string): string {
  return `bearer:${environmentId}:${new URL(httpBaseUrl).origin}`;
}

export const redeemTeamInviteAndConnectEffect = Effect.fn("clientRuntime.team.redeemInvite")(
  function* (input: TeamInviteJoinInput) {
    const httpBaseUrl = yield* normalizeTeamServerUrl(input.serverUrl);
    const presentation = yield* ClientCapabilities.ClientPresentation;
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl,
    }).pipe(Effect.mapError(mapRemoteEnvironmentError));

    const connectionId = teamBearerConnectionId(descriptor.environmentId, httpBaseUrl);
    const provisionalRoute = {
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl,
        wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
      }),
    };
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const existingEntry = (yield* SubscriptionRef.get(registry.entries)).get(
      descriptor.environmentId,
    );
    if (existingEntry !== undefined && existingEntry.target._tag === "PrimaryConnectionTarget") {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail:
          "This team server is already managed locally by this app and cannot be overwritten with a team invite.",
      });
    }
    // Reject spoofed addresses before spending a one-time team invite token.
    yield* registry.assertKnownAddress({
      ...provisionalRoute,
      profile: Option.some(provisionalRoute.profile),
    });

    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const dpopProof =
      descriptor.capabilities.accessTokenRenewal === true && Option.isSome(signer)
        ? yield* signer.value
            .createProof({
              method: "POST",
              url: environmentEndpointUrl(httpBaseUrl, "/api/team/invites/redeem"),
            })
            .pipe(Effect.option)
        : Option.none<string>();

    const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: httpBaseUrl });
    const redeemed = yield* client.team.redeemInvite({
      headers: Option.isSome(dpopProof) ? { dpop: dpopProof.value } : {},
      payload: {
        token: input.token.trim(),
        pseudo: input.pseudo.trim(),
        ...(presentation.metadata.label ? { clientLabel: presentation.metadata.label } : {}),
        ...(presentation.metadata.deviceType
          ? { clientDeviceType: presentation.metadata.deviceType }
          : {}),
        ...(presentation.metadata.os ? { clientOs: presentation.metadata.os } : {}),
      },
    });

    const label = redeemed.team.name || descriptor.label;
    const route = {
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label,
        httpBaseUrl,
        wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
      }),
    };
    const credential =
      redeemed.tokenType === "DPoP"
        ? new DpopConnectionCredential({
            accessToken: redeemed.accessToken,
            expiresAtEpochMs: (yield* Clock.currentTimeMillis) + redeemed.expiresIn * 1_000,
          })
        : new BearerConnectionCredential({
            token: redeemed.accessToken,
          });

    const registered = yield* registry.register(
      new BearerConnectionRegistration({ ...route, credential }),
      { knownAddressOnly: true },
    );
    if (!registered) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail:
          "This team server is already managed locally by this app and cannot be overwritten with a team invite.",
      });
    }
    yield* registry.setCompatibility(descriptor.environmentId, null);
    yield* registry
      .setEnabled(descriptor.environmentId, true)
      .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }));

    return {
      environmentId: descriptor.environmentId,
      team: redeemed.team,
      member: redeemed.member,
    };
  },
);
