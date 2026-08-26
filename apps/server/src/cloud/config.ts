import { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const CLOUD_MINT_PUBLIC_KEY = "cloud-mint-ed25519-public-key";
export const CLOUD_ENDPOINT_RUNTIME_CONFIG = "cloud-endpoint-runtime-config";
export const CLOUD_LINKED_USER_ID = "cloud-linked-user-id";
export const RELAY_URL_SECRET = "cloud-relay-url";
export const RELAY_ISSUER_SECRET = "cloud-relay-issuer";
export const RELAY_ENVIRONMENT_CREDENTIAL_SECRET = "cloud-relay-environment-credential";
export const PUBLISH_AGENT_ACTIVITY_SECRET = "cloud-publish-agent-activity";

export const encodeEndpointRuntimeConfigJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayManagedEndpointRuntimeConfig),
);

export const decodeRuntimeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayManagedEndpointRuntimeConfig),
);

export function isAgentActivityPublishingEnabledValue(value: string | null): boolean {
  return value === "true";
}

/** Whether agent-activity publishes currently leave this environment: the
    publish opt-in secret is enabled and the relay link credentials exist.
    Mirrors the per-publish gate in AgentAwarenessRelay, so the descriptor
    capability never advertises publishing that the publisher would skip. */
export const readAgentActivityPublishingActive = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const readSecretString = (name: string) =>
      secrets
        .get(name)
        .pipe(
          Effect.map((bytes) =>
            Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null,
          ),
        );
    const [enabled, url, environmentCredential] = yield* Effect.all([
      readSecretString(PUBLISH_AGENT_ACTIVITY_SECRET),
      readSecretString(RELAY_URL_SECRET),
      readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    // Empty strings are as unconfigured as missing files: the publisher's
    // truthiness gate skips them, so the capability must too.
    return (
      isAgentActivityPublishingEnabledValue(enabled) &&
      url !== null &&
      url !== "" &&
      environmentCredential !== null &&
      environmentCredential !== ""
    );
  }).pipe(Effect.orElseSucceed(() => false));
