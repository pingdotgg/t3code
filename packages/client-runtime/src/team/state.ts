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
  type TeamWorkspace,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
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
  readonly memberById: ReadonlyMap<TeamMemberId, TeamMember>;
  readonly attributionByThreadId: ReadonlyMap<ThreadId, TeamThreadAttribution>;
}

export const EMPTY_TEAM_ENVIRONMENT_STATE: TeamEnvironmentState = {
  team: null,
  currentMember: null,
  members: [],
  invites: [],
  threadAttributions: [],
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
  return {
    team: snapshot.team,
    currentMember: snapshot.currentMember,
    members: snapshot.members,
    invites: snapshot.invites,
    threadAttributions: snapshot.threadAttributions,
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

    const connectionId = teamBearerConnectionId(descriptor.environmentId, httpBaseUrl);
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

    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* registry.register(new BearerConnectionRegistration({ ...route, credential }), {
      knownAddressOnly: false,
    });
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
