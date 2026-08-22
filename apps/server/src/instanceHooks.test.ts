import {
  ServerStopHookInvalidUrlError,
  ServerStopHookNotConfiguredError,
  ServerStopHookUnexpectedStatusError,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as InstanceHooks from "./instanceHooks.ts";
import * as ServerSettings from "./serverSettings.ts";

interface RecordedHookRequest {
  readonly method: string;
  readonly url: string;
}

const makeHookEndpointLayer = (requests: Array<RecordedHookRequest>, status: number) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({ method: request.method, url: request.url });
        return HttpClientResponse.fromWeb(request, new Response(null, { status }));
      }),
    ),
  );

const isNotConfiguredError = Schema.is(ServerStopHookNotConfiguredError);
const isInvalidUrlError = Schema.is(ServerStopHookInvalidUrlError);
const isUnexpectedStatusError = Schema.is(ServerStopHookUnexpectedStatusError);

it.effect("DELETEs the stop hook and reports the instance as stopping on 204", () =>
  Effect.gen(function* () {
    const requests: Array<RecordedHookRequest> = [];
    const result = yield* InstanceHooks.runStopHook.pipe(
      Effect.provide(
        Layer.mergeAll(
          makeHookEndpointLayer(requests, 204),
          ServerSettings.layerTest({ stopHookUrl: "https://mgmt.example.test/instances/1/stop" }),
        ),
      ),
    );
    assert.deepEqual(result, { outcome: "stopped" });
    assert.deepEqual(requests, [
      { method: "DELETE", url: "https://mgmt.example.test/instances/1/stop" },
    ]);
  }),
);

it.effect("clears the stop hook setting when the endpoint is gone", () =>
  Effect.gen(function* () {
    const requests: Array<RecordedHookRequest> = [];
    const settingsLayer = ServerSettings.layerTest({
      stopHookUrl: "https://mgmt.example.test/instances/1/stop",
    });
    const result = yield* Effect.gen(function* () {
      const outcome = yield* InstanceHooks.runStopHook.pipe(
        Effect.provide(makeHookEndpointLayer(requests, 404)),
      );
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      return { outcome, stopHookUrl: settings.stopHookUrl };
    }).pipe(Effect.provide(settingsLayer));
    assert.deepEqual(result.outcome, { outcome: "gone" });
    assert.equal(result.stopHookUrl, null);
  }),
);

it.effect("keeps a stop hook reconfigured while the 404 request was in flight", () =>
  Effect.gen(function* () {
    const staleUrl = "https://mgmt.example.test/instances/1/stop";
    const replacementUrl = "https://mgmt.example.test/instances/2/stop";
    const settingsLayer = ServerSettings.layerTest({ stopHookUrl: staleUrl });
    const result = yield* Effect.gen(function* () {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      // The endpoint swaps the configured hook mid-request, before answering
      // 404 for the stale URL.
      const swappingEndpointLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          serverSettings.updateSettings({ stopHookUrl: replacementUrl }).pipe(
            Effect.orDie,
            Effect.map(() =>
              HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
            ),
          ),
        ),
      );
      const outcome = yield* InstanceHooks.runStopHook.pipe(Effect.provide(swappingEndpointLayer));
      const settings = yield* serverSettings.getSettings;
      return { outcome, stopHookUrl: settings.stopHookUrl };
    }).pipe(Effect.provide(settingsLayer));
    assert.deepEqual(result.outcome, { outcome: "gone" });
    assert.equal(result.stopHookUrl, replacementUrl);
  }),
);

it.effect("fails when no stop hook is configured", () =>
  Effect.gen(function* () {
    const requests: Array<RecordedHookRequest> = [];
    const failure = yield* InstanceHooks.runStopHook.pipe(
      Effect.provide(
        Layer.mergeAll(makeHookEndpointLayer(requests, 204), ServerSettings.layerTest()),
      ),
      Effect.flip,
    );
    assert.isTrue(isNotConfiguredError(failure));
    assert.deepEqual(requests, []);
  }),
);

it.effect("refuses a stop hook that is not an http(s) URL without issuing a request", () =>
  Effect.gen(function* () {
    const requests: Array<RecordedHookRequest> = [];
    const failure = yield* InstanceHooks.runStopHook.pipe(
      Effect.provide(
        Layer.mergeAll(
          makeHookEndpointLayer(requests, 204),
          ServerSettings.layerTest({ stopHookUrl: "file:///etc/passwd" }),
        ),
      ),
      Effect.flip,
    );
    assert.isTrue(isInvalidUrlError(failure));
    assert.equal(isInvalidUrlError(failure) ? failure.protocol : null, "file:");
    assert.deepEqual(requests, []);
  }),
);

it.effect("reports an unparsable stop hook URL as invalid rather than a failed request", () =>
  Effect.gen(function* () {
    const requests: Array<RecordedHookRequest> = [];
    const failure = yield* InstanceHooks.runStopHook.pipe(
      Effect.provide(
        Layer.mergeAll(
          makeHookEndpointLayer(requests, 204),
          ServerSettings.layerTest({ stopHookUrl: "not a url" }),
        ),
      ),
      Effect.flip,
    );
    assert.isTrue(isInvalidUrlError(failure));
    assert.equal(isInvalidUrlError(failure) ? failure.protocol : "unset", null);
    assert.deepEqual(requests, []);
  }),
);

it.effect("surfaces unexpected statuses without clearing the hook", () =>
  Effect.gen(function* () {
    const requests: Array<RecordedHookRequest> = [];
    const settingsLayer = ServerSettings.layerTest({
      stopHookUrl: "https://mgmt.example.test/instances/1/stop",
    });
    const result = yield* Effect.gen(function* () {
      const failure = yield* InstanceHooks.runStopHook.pipe(
        Effect.provide(makeHookEndpointLayer(requests, 500)),
        Effect.flip,
      );
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      return { failure, stopHookUrl: settings.stopHookUrl };
    }).pipe(Effect.provide(settingsLayer));
    assert.isTrue(isUnexpectedStatusError(result.failure));
    assert.equal(isUnexpectedStatusError(result.failure) ? result.failure.status : null, 500);
    assert.equal(result.stopHookUrl, "https://mgmt.example.test/instances/1/stop");
  }),
);
