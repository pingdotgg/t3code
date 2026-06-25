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

const TRUE_BYTES = new TextEncoder().encode("true");

export const readCliDesiredCloudLink = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return Option.isSome(yield* secrets.get(CLOUD_CLI_DESIRED_LINK_SECRET));
});

export const setCliDesiredCloudLink = Effect.fn("cloud.cli_state.set_desired")(function* (
  desired: boolean,
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  if (desired) {
    yield* secrets.set(CLOUD_CLI_DESIRED_LINK_SECRET, TRUE_BYTES);
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
