import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const DEFAULT_CLIENT_LABEL = "T3 external client";

/**
 * A paired environment session. Persist it with `encodeCredential`; the token
 * stays redacted in memory and in logs. Revoke it from Settings > Connections.
 */
export class T3Credential extends Schema.Class<T3Credential>("T3Credential")({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  token: Schema.RedactedFromValue(Schema.String),
}) {}

const T3CredentialJson = Schema.fromJsonString(T3Credential);
/** JSON text for storing a credential, for example in a 0600 file. It contains the token. */
export const encodeCredential = Schema.encodeEffect(T3CredentialJson);
export const decodeCredential = Schema.decodeEffect(T3CredentialJson);

export interface PairInput {
  /** A pairing link from Settings > Connections. */
  readonly pairingUrl?: string;
  /** Host and code, as an alternative to `pairingUrl`. */
  readonly host?: string;
  readonly pairingCode?: string;
  /** Shown in the environment's connection list. */
  readonly label?: string;
}

export const clientPresentation = (input: { readonly label?: string }) =>
  ClientCapabilities.ClientPresentation.of({
    metadata: { label: input.label ?? DEFAULT_CLIENT_LABEL, surface: "cli" },
  });

/**
 * Exchanges a one-time pairing credential for a bearer session. The session gets
 * the scopes the pairing link grants; create the link with `--scope` to narrow them.
 */
export const pair = Effect.fn("T3Client.pair")(function* (input: PairInput) {
  const registration = yield* ConnectionOnboarding.preparePairingRegistration({
    ...(input.pairingUrl === undefined ? {} : { pairingUrl: input.pairingUrl }),
    ...(input.host === undefined ? {} : { host: input.host }),
    ...(input.pairingCode === undefined ? {} : { pairingCode: input.pairingCode }),
  }).pipe(Effect.provideService(ClientCapabilities.ClientPresentation, clientPresentation(input)));
  return new T3Credential({
    environmentId: registration.target.environmentId,
    label: registration.target.label,
    httpBaseUrl: registration.profile.httpBaseUrl,
    wsBaseUrl: registration.profile.wsBaseUrl,
    token: Redacted.make(registration.credential.token),
  });
});
