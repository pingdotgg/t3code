import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINK_REVOKED,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";

export const CLOUD_CLI_DESIRED_LINK_SECRET = "cloud-cli-desired-link";

// Older hosts read any value in the classic intent key as a request for a paid tunnel.
export const CLOUD_CLI_DESIRED_BETA_LINK = "cloud-cli-desired-beta-link";
// The first enrollment POST claims this file. Its relay still owns the slot if the response is lost.
export const CLOUD_CLI_BETA_ENROLLMENT_RELAY = "cloud-cli-beta-enrollment-relay";
const BetaEnrollmentAttempt = Schema.fromJsonString(
  Schema.Struct({
    relayUrl: Schema.String,
    owner: Schema.optionalKey(Schema.String),
    attemptId: Schema.String.check(Schema.isUUID(4)),
  }),
);
export const encodeBetaEnrollmentAttempt = Schema.encodeEffect(BetaEnrollmentAttempt);
export const decodeBetaEnrollmentAttempt = Schema.decodeOption(BetaEnrollmentAttempt);

export type CliDesiredLinkMode = "managed" | "publish_only" | "beta";

const MANAGED_BYTES = new TextEncoder().encode("managed");
const PUBLISH_ONLY_BYTES = new TextEncoder().encode("publish_only");

export const readCliDesiredCloudLink = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return (
    Option.isSome(yield* secrets.get(CLOUD_CLI_DESIRED_BETA_LINK)) ||
    Option.isSome(yield* secrets.get(CLOUD_CLI_DESIRED_LINK_SECRET))
  );
});

export const readCliDesiredLinkMode = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  if (Option.isSome(yield* secrets.get(CLOUD_CLI_DESIRED_BETA_LINK))) return "beta" as const;
  const value = yield* secrets.get(CLOUD_CLI_DESIRED_LINK_SECRET);
  if (Option.isNone(value)) {
    return "managed" as CliDesiredLinkMode;
  }
  return new TextDecoder().decode(value.value) === "publish_only"
    ? ("publish_only" as CliDesiredLinkMode)
    : ("managed" as CliDesiredLinkMode);
});

export const setCliDesiredCloudLink = Effect.fn("cloud.cli_state.set_desired")(function* (
  desired: boolean,
  mode: Exclude<CliDesiredLinkMode, "beta"> = "managed",
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* secrets.remove(CLOUD_CLI_DESIRED_BETA_LINK);
  if (desired) {
    yield* secrets.set(
      CLOUD_CLI_DESIRED_LINK_SECRET,
      mode === "publish_only" ? PUBLISH_ONLY_BYTES : MANAGED_BYTES,
    );
  } else {
    yield* secrets.remove(CLOUD_CLI_DESIRED_LINK_SECRET);
  }
});

export const setCliDesiredBetaLink = Effect.fn("cloud.cli_state.set_desired_beta")(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* secrets.remove(CLOUD_CLI_DESIRED_LINK_SECRET);
  yield* secrets.set(CLOUD_CLI_DESIRED_BETA_LINK, new TextEncoder().encode("true"));
});

export const dropRevokedCloudLink = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  if (Option.isNone(yield* secrets.get(CLOUD_LINK_REVOKED))) {
    return false;
  }
  yield* Effect.all(
    [
      secrets.remove(CLOUD_LINKED_USER_ID),
      secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
      secrets.remove(CLOUD_MINT_PUBLIC_KEY),
      secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      secrets.remove(CLOUD_ENDPOINT_CONFIRMED_ORIGIN),
      secrets.remove(CLOUD_CLI_BETA_ENROLLMENT_RELAY),
    ],
    { concurrency: "unbounded" },
  );
  // Last, so a failed removal above leaves the mark for the next attempt.
  yield* secrets.remove(CLOUD_LINK_REVOKED);
  return true;
});

export const clearPersistedCloudLink = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* Effect.all(
    [
      secrets.remove(CLOUD_CLI_DESIRED_LINK_SECRET),
      secrets.remove(CLOUD_CLI_DESIRED_BETA_LINK),
      secrets.remove(CLOUD_LINKED_USER_ID),
      secrets.remove(RELAY_URL_SECRET),
      secrets.remove(RELAY_ISSUER_SECRET),
      secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
      secrets.remove(CLOUD_MINT_PUBLIC_KEY),
      secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      secrets.remove(CLOUD_ENDPOINT_CONFIRMED_ORIGIN),
      secrets.remove(PUBLISH_AGENT_ACTIVITY_SECRET),
      secrets.remove(CLOUD_LINK_REVOKED),
    ],
    { concurrency: "unbounded" },
  );
});
