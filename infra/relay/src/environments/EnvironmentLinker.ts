import {
  RelayEnvironmentLinkProofPayload,
  type RelayEnvironmentLinkProofInvalidReason,
  type RelayEnvironmentLinkRequest,
} from "@t3tools/contracts/relay";
import {
  decodeRelayJwt,
  normalizeRelayIssuer,
  RELAY_LINK_PROOF_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";
import * as RelayConfiguration from "../Config.ts";

export class EnvironmentLinkProofExpired extends Data.TaggedError("EnvironmentLinkProofExpired")<{
  readonly expiresAt: string;
}> {}

export class EnvironmentLinkProofInvalid extends Data.TaggedError("EnvironmentLinkProofInvalid")<{
  readonly environmentId: string;
  readonly reason: RelayEnvironmentLinkProofInvalidReason;
}> {}

export type EnvironmentLinkError =
  | EnvironmentLinkProofExpired
  | EnvironmentLinkProofInvalid
  | DpopProofs.DpopProofReplayPersistenceError
  | EnvironmentLinks.EnvironmentLinkUpsertPersistenceError
  | EnvironmentCredentials.EnvironmentCredentialCreatePersistenceError
  | ManagedEndpointProvider.ManagedEndpointProviderError;

export interface EnvironmentLinkerShape {
  readonly link: (input: {
    readonly userId: string;
    readonly request: RelayEnvironmentLinkRequest;
  }) => Effect.Effect<
    {
      readonly environmentId: RelayEnvironmentLinkProofPayload["environmentId"];
      readonly endpoint: RelayEnvironmentLinkProofPayload["endpoint"];
      readonly endpointRuntime:
        | ManagedEndpointProvider.ManagedEndpointProvisioningResult["runtime"]
        | null;
      readonly environmentCredential: string;
    },
    EnvironmentLinkError
  >;
}

export class EnvironmentLinker extends Context.Service<EnvironmentLinker, EnvironmentLinkerShape>()(
  "t3code-relay/environments/EnvironmentLinker",
) {}

const decodeProof = Schema.decodeUnknownEffect(RelayEnvironmentLinkProofPayload);

function proofAuthorizesRequestedCapabilities(
  proof: RelayEnvironmentLinkProofPayload,
  request: RelayEnvironmentLinkRequest,
): boolean {
  const scopes = new Set(proof.scopes);
  if (request.managedTunnelsEnabled && !scopes.has("managed_tunnels")) {
    return false;
  }
  return !(
    (request.notificationsEnabled || request.liveActivitiesEnabled) &&
    !scopes.has("agent_activity_notifications")
  );
}

function isSecureManagedEndpoint(endpoint: RelayEnvironmentLinkProofPayload["endpoint"]): boolean {
  try {
    const httpUrl = new URL(endpoint.httpBaseUrl);
    const wsUrl = new URL(endpoint.wsBaseUrl);
    return httpUrl.protocol === "https:" && wsUrl.protocol === "wss:";
  } catch {
    return false;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1");
}

function isLoopbackManagedTunnelOrigin(
  origin: RelayEnvironmentLinkProofPayload["origin"],
): boolean {
  const hostname = normalizeHostname(origin.localHttpHost);
  return (
    (hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost") &&
    Number.isInteger(origin.localHttpPort) &&
    origin.localHttpPort > 0 &&
    origin.localHttpPort <= 65_535
  );
}

const make = Effect.gen(function* () {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
  const managedEndpointProvider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
  const proofReplay = yield* DpopProofs.DpopProofReplay;
  const relayTokens = yield* RelayTokens.RelayTokens;
  const config = yield* RelayConfiguration.RelayConfiguration;

  return EnvironmentLinker.of({
    link: Effect.fn("relay.environment_linker.link")(function* (input) {
      const now = yield* DateTime.now;
      const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
      const unverified = yield* Effect.try({
        try: () => decodeRelayJwt(input.request.proof),
        catch: () =>
          new EnvironmentLinkProofInvalid({
            environmentId: "unknown",
            reason: "invalid_signature_or_scope",
          }),
      });
      const decoded = yield* decodeProof(unverified).pipe(Effect.option);
      if (decoded._tag === "None") {
        return yield* new EnvironmentLinkProofInvalid({
          environmentId: "unknown",
          reason: "invalid_signature_or_scope",
        });
      }
      const candidate = decoded.value;
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": candidate.environmentId,
        "relay.link.notifications_enabled": input.request.notificationsEnabled,
        "relay.link.live_activities_enabled": input.request.liveActivitiesEnabled,
        "relay.link.managed_tunnels_enabled": input.request.managedTunnelsEnabled,
      });
      if (candidate.exp <= nowSeconds) {
        return yield* new EnvironmentLinkProofExpired({
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(candidate.exp * 1_000)),
        });
      }
      const issuer = `t3-env:${candidate.environmentId}`;
      const relayIssuer = normalizeRelayIssuer(config.relayIssuer);
      const verified = yield* verifyRelayJwt({
        publicKey: candidate.environmentPublicKey,
        token: input.request.proof,
        typ: RELAY_LINK_PROOF_TYP,
        issuer,
        audience: relayIssuer,
        nowEpochSeconds: nowSeconds,
      }).pipe(
        Effect.flatMap(decodeProof),
        Effect.mapError(
          () =>
            new EnvironmentLinkProofInvalid({
              environmentId: candidate.environmentId,
              reason: "invalid_signature_or_scope",
            }),
        ),
      );
      if (
        verified.sub !== verified.environmentId ||
        !proofAuthorizesRequestedCapabilities(verified, input.request)
      ) {
        return yield* new EnvironmentLinkProofInvalid({
          environmentId: candidate.environmentId,
          reason: "invalid_signature_or_scope",
        });
      }
      if (verified.descriptor.environmentId !== verified.environmentId) {
        return yield* new EnvironmentLinkProofInvalid({
          environmentId: verified.environmentId,
          reason: "descriptor_mismatch",
        });
      }
      const challenge = yield* relayTokens.verifyLinkChallenge({
        token: verified.challenge,
        userId: input.userId,
        request: {
          notificationsEnabled: input.request.notificationsEnabled,
          liveActivitiesEnabled: input.request.liveActivitiesEnabled,
          managedTunnelsEnabled: input.request.managedTunnelsEnabled,
        },
        nowEpochSeconds: nowSeconds,
      });
      if (challenge === null) {
        return yield* new EnvironmentLinkProofInvalid({
          environmentId: verified.environmentId,
          reason: "challenge_invalid",
        });
      }
      const expiresAt = DateTime.make(verified.exp * 1_000);
      if (expiresAt._tag === "None") {
        return yield* new EnvironmentLinkProofInvalid({
          environmentId: verified.environmentId,
          reason: "invalid_signature_or_scope",
        });
      }
      const consumedNonce = yield* proofReplay.consume({
        thumbprint: verified.environmentPublicKey,
        jti: verified.jti,
        iat: verified.iat,
        expiresAt: expiresAt.value,
      });
      if (!consumedNonce) {
        return yield* new EnvironmentLinkProofInvalid({
          environmentId: verified.environmentId,
          reason: "replayed_nonce",
        });
      }
      const consumedChallenge = yield* proofReplay.consume({
        thumbprint: "relay-environment-link-challenge",
        jti: challenge.jti,
        iat: challenge.iat,
        expiresAt: expiresAt.value,
      });
      if (!consumedChallenge) {
        return yield* new EnvironmentLinkProofInvalid({
          environmentId: verified.environmentId,
          reason: "challenge_invalid",
        });
      }
      if (input.request.managedTunnelsEnabled && !isLoopbackManagedTunnelOrigin(verified.origin)) {
        return yield* new EnvironmentLinkProofInvalid({
          environmentId: verified.environmentId,
          reason: "origin_not_allowed",
        });
      }
      const provisioned = input.request.managedTunnelsEnabled
        ? yield* managedEndpointProvider.provision({
            userId: input.userId,
            environmentId: verified.environmentId,
            origin: verified.origin,
          })
        : null;
      const endpoint = provisioned?.endpoint ?? verified.endpoint;
      if (!isSecureManagedEndpoint(endpoint)) {
        return yield* new EnvironmentLinkProofInvalid({
          environmentId: verified.environmentId,
          reason: "endpoint_not_secure",
        });
      }
      yield* links.upsert({ ...input, proof: verified, endpoint });
      const environmentCredential = yield* credentials.create({
        environmentId: verified.environmentId,
        environmentPublicKey: verified.environmentPublicKey,
      });
      return {
        environmentId: verified.environmentId,
        endpoint,
        endpointRuntime: provisioned?.runtime ?? null,
        environmentCredential,
      };
    }),
  });
});

export const layer = Layer.effect(EnvironmentLinker, make);
