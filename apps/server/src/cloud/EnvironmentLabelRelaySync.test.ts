import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "./config.ts";
import {
  runEnvironmentLabelRelaySync,
  synchronizeCurrentEnvironmentLabelWithRelay,
} from "./EnvironmentLabelRelaySync.ts";

const environmentId = EnvironmentId.make("environment-test");
const encode = (value: string) => new TextEncoder().encode(value);

function makeSecretStore() {
  const values = new Map([
    [RELAY_URL_SECRET, encode("https://relay.example.test")],
    [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("relay-credential")],
  ]);
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromUndefinedOr(values.get(name))),
    set: () => Effect.die("unused"),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
  });
}

function descriptor(label: string): ExecutionEnvironmentDescriptor {
  return {
    environmentId,
    label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true },
  };
}

function response(request: HttpClientRequest.HttpClientRequest) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function requestLabel(request: HttpClientRequest.HttpClientRequest): string {
  assert.equal(request.body._tag, "Uint8Array");
  if (request.body._tag !== "Uint8Array") return "";
  return (JSON.parse(new TextDecoder().decode(request.body.body)) as { readonly label: string })
    .label;
}

it.effect("synchronizes the current descriptor label with the relay", () =>
  Effect.gen(function* () {
    const requests: Array<{ readonly label: string; readonly authorization: string | undefined }> =
      [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          label: requestLabel(request),
          authorization: request.headers.authorization,
        });
        return response(request);
      }),
    );

    yield* synchronizeCurrentEnvironmentLabelWithRelay().pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, makeSecretStore()),
      Effect.provideService(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.succeed(descriptor("Current label")),
        setEnvironmentLabel: () => Effect.void,
      }),
      Effect.provideService(HttpClient.HttpClient, client),
    );

    assert.deepStrictEqual(requests, [
      { label: "Current label", authorization: "Bearer relay-credential" },
    ]);
  }),
);

it.effect("cancels an older synchronization when a newer label arrives", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
      const currentLabel = yield* Ref.make("");
      const requestLabels = yield* Ref.make<ReadonlyArray<string>>([]);
      const oldRequestStarted = yield* Deferred.make<void>();
      const newRequestCompleted = yield* Deferred.make<void>();
      const releaseOldRequest = yield* Deferred.make<void>();
      const client = HttpClient.make((request) => {
        const label = requestLabel(request);
        const record = Ref.update(requestLabels, (labels) => [...labels, label]);
        if (label === "Old label") {
          return record.pipe(
            Effect.andThen(Deferred.succeed(oldRequestStarted, undefined)),
            Effect.andThen(Deferred.await(releaseOldRequest)),
            Effect.as(response(request)),
          );
        }
        return record.pipe(
          Effect.andThen(Deferred.succeed(newRequestCompleted, undefined)),
          Effect.as(response(request)),
        );
      });
      const settings = ServerSettings.ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, environmentLabel: "Old label" }),
        updateSettings: () => Effect.die("unused"),
        streamChanges: Stream.empty,
        subscribeChanges: PubSub.subscribe(changes).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        ),
      });
      const environment = ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Ref.get(currentLabel).pipe(Effect.map(descriptor)),
        setEnvironmentLabel: (label) => Ref.set(currentLabel, label),
      });

      const fiber = yield* runEnvironmentLabelRelaySync().pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, makeSecretStore()),
        Effect.provideService(ServerSettings.ServerSettingsService, settings),
        Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.forkScoped,
      );

      yield* Deferred.await(oldRequestStarted);
      yield* PubSub.publish(changes, {
        ...DEFAULT_SERVER_SETTINGS,
        environmentLabel: "New label",
      });
      yield* Deferred.await(newRequestCompleted);

      assert.deepStrictEqual(yield* Ref.get(requestLabels), ["Old label", "New label"]);
      assert.equal(yield* Ref.get(currentLabel), "New label");
      yield* Fiber.interrupt(fiber);
    }),
  ),
);
