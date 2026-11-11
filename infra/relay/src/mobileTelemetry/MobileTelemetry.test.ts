import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { RelayApi } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { RELAY_HTTP_ROUTER_CONFIG } from "../http/Api.ts";
import * as RelayHttpApi from "../http/Api.ts";
import * as MobileTelemetry from "./MobileTelemetry.ts";

const PROJECT_ID = "d763fcb8-d37c-41ea-a773-b54a0ab4a454";
const UPDATE_ID = "0198e8a4-1111-7000-8000-000000000001";
const BUILD_ID = "0198e8a4-2222-7000-8000-000000000002";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const destinations = {
  traces: { url: "https://axiom.test/v1/traces", dataset: "mobile-traces" },
  logs: { url: "https://axiom.test/v1/logs", dataset: "mobile-logs" },
  metrics: { url: "https://axiom.test/v1/metrics", dataset: "mobile-metrics" },
} as const;

/** Maps generated column 12 of the one-line bundle to `src/App.tsx` 1:2. */
const SOURCE_MAP = encodeJson({ version: 3, sources: ["src/App.tsx"], mappings: "AAAA,UAAE" });
const STACK = "Error: x\n    at render (address at index.android.bundle:1:12)";

interface Harness {
  readonly execute?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
  /** The source maps bucket, by key. */
  readonly objects?: Readonly<Record<string, string>>;
}

const makeHarness = (options: Harness = {}) => {
  const sent: Array<HttpClientRequest.HttpClientRequest> = [];
  const execute =
    options.execute ??
    ((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
        ),
      ));
  const layerTelemetry = MobileTelemetry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(MobileTelemetry.MobileTelemetrySettings, {
          axiomToken: Redacted.make("axiom-ingest-token"),
          destinations,
        }),
        Layer.succeed(MobileTelemetry.MobileTelemetryRateLimiter, {
          allow: () => Effect.succeed(true),
        }),
        MobileTelemetry.layerSourceMaps.pipe(
          Layer.provide(
            Layer.succeed(MobileTelemetry.SourceMapObjects, {
              get: (key) =>
                Effect.sync(() => {
                  const object = options.objects?.[key];
                  return object === undefined
                    ? undefined
                    : { size: object.length, text: Effect.succeed(object) };
                }),
            }),
          ),
        ),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            sent.push(request);
            return execute(request);
          }),
        ),
      ),
    ),
  );
  const httpEffect = HttpRouter.toHttpEffect(
    Layer.mergeAll(
      HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.mobileTelemetry)).pipe(
        Layer.provide(MobileTelemetry.layerApi.pipe(Layer.provide(layerTelemetry))),
        Layer.provide([NodeServices.layer, NodeHttpPlatform.layer, Etag.layerWeak]),
      ),
      RelayHttpApi.layerNotFoundRoute,
    ),
  ).pipe(Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG));
  const send = (request: Request) =>
    Effect.gen(function* () {
      const handler = yield* httpEffect;
      const response = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
      yield* HttpEffect.toHandled(handler, (_request, value) =>
        Deferred.succeed(response, value),
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      );
      return yield* Deferred.await(response);
    });
  return { sent, send };
};

const ingest = (signal: string, body: string) =>
  new Request(`https://relay.test/v1/mobile/observe/${PROJECT_ID}/v1/${signal}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body,
  });

const sentText = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });

/** One resource's JS exception, as Observe reports it from the app's bundle. */
const exceptionResource = (resource: ReadonlyArray<ReturnType<typeof str>>) => ({
  resource: { attributes: resource },
  scopeLogs: [
    {
      logRecords: [
        {
          attributes: [str("expo.error.source", "global"), str("exception.stacktrace", STACK)],
        },
      ],
    },
  ],
});

/** Each forwarded exception record's string attributes. */
const forwardedExceptions = (request: HttpClientRequest.HttpClientRequest) => {
  const payload = decodeJson(sentText(request)) as {
    resourceLogs: Array<{
      scopeLogs: Array<{
        logRecords: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }>;
      }>;
    }>;
  };
  return payload.resourceLogs.map((resourceLogs) =>
    Object.fromEntries(
      resourceLogs.scopeLogs[0]!.logRecords[0]!.attributes.map(({ key, value }) => [
        key,
        value.stringValue,
      ]),
    ),
  );
};

describe("MobileTelemetry", () => {
  it.effect("forwards each signal to its Axiom dataset with the relay's token", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const body = encodeJson({ resourceMetrics: [] });
      for (const signal of ["metrics", "traces", "logs"] as const) {
        const response = yield* harness.send(ingest(signal, body));
        expect(response.status).toBe(200);
      }
      expect(
        harness.sent.map((request) => ({
          url: request.url,
          authorization: request.headers.authorization,
          dataset: request.headers["x-axiom-dataset"],
          body: sentText(request),
        })),
      ).toEqual(
        (["metrics", "traces", "logs"] as const).map((signal) => ({
          url: destinations[signal].url,
          authorization: "Bearer axiom-ingest-token",
          dataset: destinations[signal].dataset,
          body,
        })),
      );
    }),
  );

  it.effect("passes Axiom's status and Retry-After back for Observe's retries", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        execute: (request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response('{"message":"slow down"}', {
                status: 429,
                headers: { "content-type": "application/json", "retry-after": "30" },
              }),
            ),
          ),
      });
      const response = yield* harness.send(ingest("metrics", "{}"));
      expect(response.status).toBe(429);
      expect(response.headers["retry-after"]).toBe("30");
    }),
  );

  it.effect("symbolicates JS exceptions with the OTA update's map, else the build's", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        objects: {
          [`android/ota/${UPDATE_ID}.map`]: SOURCE_MAP,
          [`ios/build/${BUILD_ID}.map`]: SOURCE_MAP,
        },
      });
      const body = encodeJson({
        resourceLogs: [
          exceptionResource([
            str("os.type", "linux"),
            str("expo.app.update_id", UPDATE_ID),
            str("expo.eas_build.id", BUILD_ID),
          ]),
          exceptionResource([str("os.type", "darwin"), str("expo.eas_build.id", BUILD_ID)]),
        ],
      });
      expect((yield* harness.send(ingest("logs", body))).status).toBe(200);
      const symbolicated = (key: string) => ({
        "expo.error.source": "global",
        "exception.stacktrace": "Error: x\n    at render (src/App.tsx:1:3)",
        "relay.symbolication.source_map": key,
        "relay.symbolication.status": "symbolicated",
        "relay.symbolication.raw_stacktrace": STACK,
      });
      expect(forwardedExceptions(harness.sent[0]!)).toEqual([
        symbolicated(`android/ota/${UPDATE_ID}.map`),
        symbolicated(`ios/build/${BUILD_ID}.map`),
      ]);
    }),
  );

  it.effect("forwards the stack untouched when the OTA update's map is missing", () =>
    Effect.gen(function* () {
      // The build's map describes the embedded bundle, not the update that threw.
      const harness = makeHarness({
        objects: { [`android/build/${BUILD_ID}.map`]: SOURCE_MAP },
      });
      const body = encodeJson({
        resourceLogs: [
          exceptionResource([
            str("os.type", "linux"),
            str("expo.app.update_id", UPDATE_ID),
            str("expo.eas_build.id", BUILD_ID),
          ]),
        ],
      });
      expect((yield* harness.send(ingest("logs", body))).status).toBe(200);
      expect(forwardedExceptions(harness.sent[0]!)).toEqual([
        {
          "expo.error.source": "global",
          "exception.stacktrace": STACK,
          "relay.symbolication.status": "source_map_missing",
        },
      ]);
    }),
  );

  it.effect("says why a stack stayed minified, without the iOS install path", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ objects: { [`ios/build/${BUILD_ID}.map`]: "{}" } });
      const iosStack =
        "Error: x\n    at render (address at /private/var/containers/Bundle/Application/" +
        "0C1D/T3Code.app/main.jsbundle:1:12)";
      const record = (stack: string) => ({
        scopeLogs: [{ logRecords: [{ attributes: [str("exception.stacktrace", stack)] }] }],
      });
      const body = encodeJson({
        resourceLogs: [
          { resource: { attributes: [str("os.type", "linux")] }, ...record(STACK) },
          {
            resource: {
              attributes: [str("os.type", "darwin"), str("expo.eas_build.id", BUILD_ID)],
            },
            ...record(iosStack),
          },
        ],
      });
      expect((yield* harness.send(ingest("logs", body))).status).toBe(200);
      expect(forwardedExceptions(harness.sent[0]!)).toEqual([
        { "exception.stacktrace": STACK, "relay.symbolication.status": "no_bundle_id" },
        {
          "exception.stacktrace": "Error: x\n    at render (address at main.jsbundle:1:12)",
          "relay.symbolication.status": "source_map_invalid",
        },
      ]);
    }),
  );

  it.effect("marks the native abort that follows a fatal JS error in the same session", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const fatal = { key: "expo.error.is_fatal", value: { boolValue: true } };
      const crash = (session: string, source: string) => ({
        attributes: [str("expo.error.source", source), str("session.id", session), fatal],
      });
      const body = encodeJson({
        resourceLogs: [
          {
            resource: { attributes: [str("os.type", "darwin")] },
            scopeLogs: [
              {
                logRecords: [
                  crash("a", "global"),
                  crash("a", "nativeCrash"),
                  crash("b", "nativeCrash"),
                ],
              },
            ],
          },
        ],
      });
      expect((yield* harness.send(ingest("logs", body))).status).toBe(200);
      const records = (
        decodeJson(sentText(harness.sent[0]!)) as {
          resourceLogs: Array<{
            scopeLogs: Array<{ logRecords: Array<{ attributes: Array<{ key: string }> }> }>;
          }>;
        }
      ).resourceLogs[0]!.scopeLogs[0]!.logRecords;
      expect(
        records.map((record) =>
          record.attributes.some((attribute) => attribute.key === "relay.crash.js_fatal"),
        ),
      ).toEqual([false, true, false]);
    }),
  );

  it.effect("answers 413 for a body over the cap without forwarding it", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const tooLarge = "x".repeat(MobileTelemetry.MOBILE_TELEMETRY_MAX_BODY_BYTES + 1);
      expect((yield* harness.send(ingest("logs", tooLarge))).status).toBe(413);
      expect(harness.sent).toEqual([]);
    }),
  );

  it.effect("decodes one source map at a time", () =>
    Effect.gen(function* () {
      const releaseFirst = yield* Deferred.make<void>();
      const firstStarted = yield* Deferred.make<void>();
      let firstDone = false;
      let secondSawFirstDone: boolean | undefined;
      const sourceMaps = yield* MobileTelemetry.SourceMaps.pipe(
        Effect.provide(MobileTelemetry.layerSourceMaps),
        Effect.provideService(MobileTelemetry.SourceMapObjects, {
          get: (key) =>
            key === "first"
              ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFirst)),
                  Effect.as({ size: SOURCE_MAP.length, text: Effect.succeed(SOURCE_MAP) }),
                  Effect.ensuring(Effect.sync(() => (firstDone = true))),
                )
              : Effect.sync(() => {
                  secondSawFirstDone = firstDone;
                  return { size: SOURCE_MAP.length, text: Effect.succeed(SOURCE_MAP) };
                }),
        }),
      );
      const first = yield* Effect.forkChild(sourceMaps.find("first"));
      yield* Deferred.await(firstStarted);
      const second = yield* Effect.forkChild(sourceMaps.find("second"), { startImmediately: true });
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      expect(yield* Fiber.join(second)).toMatchObject({ key: "second" });
      expect(secondSawFirstDone).toBe(true);
    }),
  );
});
