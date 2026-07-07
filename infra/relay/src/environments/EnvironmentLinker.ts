import {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkProofInvalidReason,
  type RelayEnvironmentLinkRequest,
} from "@t3tools/contracts/relay";
import {
  decodeRelayJwt,
  normalizeRelayIssuer,
  RELAY_LINK_PROOF_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as Context from "effect/Context";
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

export class EnvironmentLinkProofExpired extends Schema.TaggedErrorClass<EnvironmentLinkProofExpired>()(
  "EnvironmentLinkProofExpired",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' link proof expired at ${this.expiresAt}`;
  }
}

export class EnvironmentLinkProofInvalid extends Schema.TaggedErrorClass<EnvironmentLinkProofInvalid>()(
  "EnvironmentLinkProofInvalid",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    reason: RelayEnvironmentLinkProofInvalidReason,
    stage: Schema.Literals([
      "decode_token",
      "decode_payload",
      "verify_proof",
      "authorize_capabilities",
      "validate_descriptor",
      "verify_challenge",
      "validate_expiration",
      "consume_proof_nonce",
      "consume_challenge_nonce",
      "validate_origin",
      "validate_endpoint",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' link proof is invalid during ${this.stage}: ${this.reason}`;
  }
}

export type EnvironmentLinkError =
  | EnvironmentLinkProofExpired
  | EnvironmentLinkProofInvalid
  | DpopProofs.DpopProofReplayPersistenceError
  | EnvironmentLinks.EnvironmentLinkUpsertPersistenceError
  | EnvironmentCredentials.EnvironmentCredentialCreatePersistenceError
  | ManagedEndpointProvider.ManagedEndpointProviderError;

export class EnvironmentLinker extends Context.Service<
  EnvironmentLinker,
  {
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
>()("t3code-relay/environments/EnvironmentLinker") {}

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
        catch: (cause) =>
          new EnvironmentLinkProofInvalid({
            userId: input.userId,
            environmentId: "unknown",
            reason: "invalid_signature_or_scope",
            stage: "decode_token",
            cause,
          }),
      });
      const candidate = yield* decodeProof(unverified).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentLinkProofInvalid({
              userId: input.userId,
              environmentId: "unknown",
              reason: "invalid_signature_or_scope",
              stage: "decode_payload",
              cause,
            }),
        ),
      );
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": candidate.environmentId,
        "relay.link.notifications_enabled": input.request.notificationsEnabled,
        "relay.link.live_activities_enabled": input.request.liveActivitiesEnabled,
        "relay.link.managed_tunnels_enabled": input.request.managedTunnelsEnabled,
      });
      if (candidate.exp <= nowSeconds) {
        return yield* new EnvironmentLinkProofExpired({
          userId: input.userId,
          environmentId: candidate.environmentId,
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
          (cause) =>
            new EnvironmentLinkProofInvalid({
              userId: input.userId,
              environmentId: candidate.environmentId,
              reason: "invalid_signature_or_scope",
              stage: "verify_proof",
              cause,
            }),
        ),
      );
      if (
        verified.sub !== verified.environmentId ||
        !proofAuthorizesRequestedCapabilities(verified, input.request)
      ) {
        return yield* new EnvironmentLinkProofInvalid({
          userId: input.userId,
          environmentId: candidate.environmentId,
          reason: "invalid_signature_or_scope",
          stage: "authorize_capabilities",
        });
      }
      if (verified.descriptor.environmentId !== verified.environmentId) {
        return yield* new EnvironmentLinkProofInvalid({
          userId: input.userId,
          environmentId: verified.environmentId,
          reason: "descriptor_mismatch",
          stage: "validate_descriptor",
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
          userId: input.userId,
          environmentId: verified.environmentId,
          reason: "challenge_invalid",
          stage: "verify_challenge",
        });
      }
      const expiresAt = DateTime.make(verified.exp * 1_000);
      if (expiresAt._tag === "None") {
        return yield* new EnvironmentLinkProofInvalid({
          userId: input.userId,
          environmentId: verified.environmentId,
          reason: "invalid_signature_or_scope",
          stage: "validate_expiration",
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
          userId: input.userId,
          environmentId: verified.environmentId,
          reason: "replayed_nonce",
          stage: "consume_proof_nonce",
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
          userId: input.userId,
          environmentId: verified.environmentId,
          reason: "challenge_invalid",
          stage: "consume_challenge_nonce",
        });
      }
      if (input.request.managedTunnelsEnabled && !isLoopbackManagedTunnelOrigin(verified.origin)) {
        return yield* new EnvironmentLinkProofInvalid({
          userId: input.userId,
          environmentId: verified.environmentId,
          reason: "origin_not_allowed",
          stage: "validate_origin",
        });
      }
      // Downgrading a managed link to publish-only must release the tunnel and
      // DNS that were provisioned for it — nothing else cleans them up until a
      // full unlink. Best effort: a cleanup failure must not block the link
      // itself, and the provider treats an absent allocation as already
      // deprovisioned, so retrying on every non-tunnel link is cheap.
      if (!input.request.managedTunnelsEnabled) {
        yield* managedEndpointProvider
          .deprovision({
            userId: input.userId,
            environmentId: verified.environmentId,
          })
          .pipe(
            Effect.tapError((error) =>
              Effect.logWarning("managed endpoint deprovision on publish-only link failed", {
                environmentId: verified.environmentId,
                errorTag: error._tag,
              }),
            ),
            Effect.ignore,
          );
      }
      const provisioned = input.request.managedTunnelsEnabled
        ? yield* managedEndpointProvider.provision({
            userId: input.userId,
            environmentId: verified.environmentId,
            origin: verified.origin,
          })
        : null;
      const endpoint = provisioned?.endpoint ?? verified.endpoint;
      // The secure-endpoint requirement only matters when the relay advertises
      // this endpoint for other devices to reach (managed tunnel). Publish-only
      // links are reached out of band (e.g. Tailscale) and their stored endpoint
      // is never used for routing, so a nominal endpoint is acceptable.
      if (input.request.managedTunnelsEnabled && !isSecureManagedEndpoint(endpoint)) {
        return yield* new EnvironmentLinkProofInvalid({
          userId: input.userId,
          environmentId: verified.environmentId,
          reason: "endpoint_not_secure",
          stage: "validate_endpoint",
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
