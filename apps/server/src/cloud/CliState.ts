import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";

export const CLOUD_CLI_DESIRED_LINK_SECRET = "cloud-cli-desired-link";

// "managed" provisions a Cloudflare tunnel (default, legacy value "true").
// "publish_only" links the environment to the relay purely to publish agent
// activity — no tunnel, no relay-advertised endpoint — so activity can flow to
// mobile clients even when they reach the environment out of band (Tailscale,
// direct pairing) without T3 Connect.
export type CliDesiredLinkMode = "managed" | "publish_only";

const MANAGED_BYTES = new TextEncoder().encode("managed");
const PUBLISH_ONLY_BYTES = new TextEncoder().encode("publish_only");

export const readCliDesiredCloudLink = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return Option.isSome(yield* secrets.get(CLOUD_CLI_DESIRED_LINK_SECRET));
});

export const readCliDesiredLinkMode = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const value = yield* secrets.get(CLOUD_CLI_DESIRED_LINK_SECRET);
  if (Option.isNone(value)) {
    return "managed" as CliDesiredLinkMode;
  }
  // Legacy links stored the literal "true" and are always managed.
  return new TextDecoder().decode(value.value) === "publish_only"
    ? ("publish_only" as CliDesiredLinkMode)
    : ("managed" as CliDesiredLinkMode);
});

export const setCliDesiredCloudLink = Effect.fn("cloud.cli_state.set_desired")(function* (
  desired: boolean,
  mode: CliDesiredLinkMode = "managed",
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  if (desired) {
    yield* secrets.set(
      CLOUD_CLI_DESIRED_LINK_SECRET,
      mode === "publish_only" ? PUBLISH_ONLY_BYTES : MANAGED_BYTES,
    );
  } else {
    yield* secrets.remove(CLOUD_CLI_DESIRED_LINK_SECRET);
  }
});

export const clearPersistedCloudLink = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* Effect.all(
    [
      secrets.remove(CLOUD_CLI_DESIRED_LINK_SECRET),
      secrets.remove(CLOUD_LINKED_USER_ID),
      secrets.remove(RELAY_URL_SECRET),
      secrets.remove(RELAY_ISSUER_SECRET),
      secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
      secrets.remove(CLOUD_MINT_PUBLIC_KEY),
      secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      secrets.remove(PUBLISH_AGENT_ACTIVITY_SECRET),
    ],
    { concurrency: "unbounded" },
  );
});
