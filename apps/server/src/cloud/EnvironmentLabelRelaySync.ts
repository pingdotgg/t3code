import { RelayApi } from "@t3tools/contracts/relay";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { relayEnvironmentClient } from "../relay/relayEnvironmentClient.ts";
import * as ServerSettings from "../serverSettings.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "./config.ts";

const retrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
  Schedule.upTo({ duration: "10 minutes" }),
);

const readSecretString = (secrets: ServerSecretStore.ServerSecretStore["Service"], name: string) =>
  secrets.get(name).pipe(
    Effect.map(
      Option.match({
        onNone: () => null,
        onSome: (bytes) => new TextDecoder().decode(bytes),
      }),
    ),
  );

export const synchronizeCurrentEnvironmentLabelWithRelay = Effect.fn(
  "synchronizeCurrentEnvironmentLabelWithRelay",
)(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const [relayUrl, environmentCredential] = yield* Effect.all([
    readSecretString(secrets, RELAY_URL_SECRET),
    readSecretString(secrets, RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
  ]);
  if (!relayUrl || !environmentCredential) return;

  const descriptor = yield* environment.getDescriptor;
  const client = yield* HttpApiClient.make(RelayApi, {
    baseUrl: relayUrl,
    transformClient: relayEnvironmentClient(environmentCredential),
  });
  yield* client.server.updateEnvironmentLabel({
    params: { environmentId: descriptor.environmentId },
    payload: { label: descriptor.label },
  });
  yield* Effect.logDebug("synchronized environment label with relay", {
    environmentId: descriptor.environmentId,
  });
});

export const runEnvironmentLabelRelaySync = Effect.fn("runEnvironmentLabelRelaySync")(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const settings = yield* ServerSettings.ServerSettingsService;

  const synchronize = Effect.fn("synchronizeEnvironmentLabel")(function* (
    environmentLabel: string,
  ) {
    // Apply the triggering setting before reading the descriptor. The
    // general descriptor watcher runs independently and may not have seen
    // this settings event yet.
    yield* environment.setEnvironmentLabel(environmentLabel);
    yield* synchronizeCurrentEnvironmentLabelWithRelay();
  });

  const changes = yield* settings.subscribeChanges;
  const initialSettings = yield* settings.getSettings;
  const synchronizeWithRetry = (environmentLabel: string) =>
    synchronize(environmentLabel).pipe(
      Effect.retry({ schedule: retrySchedule }),
      Effect.catch((cause) =>
        Effect.logWarning("failed to synchronize environment label with relay", { cause }),
      ),
    );

  yield* Stream.concat(
    Stream.make(initialSettings.environmentLabel),
    changes.pipe(
      Stream.map((next) => next.environmentLabel),
      Stream.changes,
    ),
  ).pipe(
    Stream.switchMap((environmentLabel) =>
      Stream.fromEffect(synchronizeWithRetry(environmentLabel)),
    ),
    Stream.runDrain,
  );
});
