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
import * as TestClock from "effect/testing/TestClock";
import * as Etag from "effect/http/Etag";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
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
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const destinations = {
  traces: { url: "https://axiom.test/v1/traces", dataset: "relay-traces" },
  logs: { url: "https://axiom.test/v1/logs", dataset: "mobile-logs" },
  metrics: { url: "https://axiom.test/v1/metrics", dataset: "mobile-metrics" },
} as const;

/** Maps generated column 12 of the one-line bundle to `src/App.tsx` 1:2. */
const SOURCE_MAP = encodeJson({ version: 3, sources: ["src/App.tsx"], mappings: "AAAA,UAAE" });

interface Harness {
  readonly execute?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
  readonly objects?: Readonly<Record<string, string | { readonly size: number }>>;
  readonly allow?: boolean;
}

const makeHarness = Effect.fnUntraced(function* (options: Harness = {}) {
  const sent: Array<HttpClientRequest.HttpClientRequest> = [];
  const objectLookups: Array<string> = [];
  const objectReads: Array<string> = [];
  const execute =
    options.execute ??
    ((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
        ),
      ));
  // One per harness, as the Worker builds one per isolate.
  const sourceMaps = yield* MobileTelemetry.SourceMaps.pipe(
    Effect.provide(MobileTelemetry.layerSourceMaps),
    Effect.provideService(MobileTelemetry.SourceMapObjects, {
      get: (key) =>
        Effect.sync(() => {
          objectLookups.push(key);
          const object = options.objects?.[key];
          if (object === undefined) return undefined;
          return typeof object === "string"
            ? {
                size: object.length,
                text: Effect.sync(() => {
                  objectReads.push(key);
                  return object;
                }),
              }
            : { size: object.size, text: Effect.die("read an object too large to decode") };
        }),
    }),
  );
  const layerTelemetry = MobileTelemetry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(MobileTelemetry.MobileTelemetrySettings, {
          axiomToken: Redacted.make("axiom-ingest-token"),
          destinations,
        }),
        Layer.succeed(MobileTelemetry.MobileTelemetryRateLimiter, {
          allow: () => Effect.succeed(options.allow ?? true),
        }),
        Layer.succeed(MobileTelemetry.SourceMaps, sourceMaps),
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
  return { sent, objectLookups, objectReads, send };
});

const ingest = (signal: string, body: string, projectId = PROJECT_ID) =>
  new Request(`https://relay.test/v1/mobile/observe/${projectId}/v1/${signal}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body,
  });

const sentText = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";

const exceptionResourceLogs = (updateId: string, stacks: ReadonlyArray<string>) => ({
  resource: {
    attributes: [
      { key: "os.type", value: { stringValue: "linux" } },
      { key: "expo.app.update_id", value: { stringValue: updateId } },
    ],
  },
  scopeLogs: [
    {
      logRecords: stacks.map((stack) => ({
        attributes: [
          { key: "expo.error.source", value: { stringValue: "global" } },
          { key: "exception.stacktrace", value: { stringValue: stack } },
        ],
      })),
    },
  ],
});

const exceptionLogs = (...stacks: ReadonlyArray<string>) =>
  encodeJson({ resourceLogs: [exceptionResourceLogs(UPDATE_ID, stacks)] });

const forwardedStack = (request: HttpClientRequest.HttpClientRequest) => {
  const payload = decodeJson(sentText(request)) as {
    resourceLogs: Array<{
      scopeLogs: Array<{
        logRecords: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }>;
      }>;
    }>;
  };
  const attributes = payload.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes;
  return Object.fromEntries(attributes.map(({ key, value }) => [key, value.stringValue]));
};

describe("MobileTelemetry", () => {
  it.effect("forwards each signal to its Axiom dataset with the relay's token", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
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

  it.effect("symbolicates JavaScript exception stacks with the bundle's map", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        objects: { [`android/ota/${UPDATE_ID}.map`]: SOURCE_MAP },
      });
      const stack = "Error: x\n    at render (address at index.android.bundle:1:12)";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = yield* harness.send(ingest("logs", exceptionLogs(stack)));
        expect(response.status).toBe(200);
      }
      expect(forwardedStack(harness.sent[1]!)).toEqual({
        "expo.error.source": "global",
        "exception.stacktrace": "Error: x\n    at render (src/App.tsx:1:3)",
        "relay.symbolication.source_map": `android/ota/${UPDATE_ID}.map`,
        "relay.symbolication.status": "symbolicated",
        "relay.symbolication.raw_stacktrace": stack,
      });
      // The decoded map is reused for the second request.
      expect(harness.objectReads).toEqual([`android/ota/${UPDATE_ID}.map`]);
    }),
  );

  it.effect("shares one growth budget across every exception in a request", () =>
    Effect.gen(function* () {
      // Each rewritten frame grows by about 600 KiB, so only the first fits in 1 MiB.
      const longSource = `${"a".repeat(600 * 1024)}.tsx`;
      const harness = yield* makeHarness({
        objects: {
          [`android/ota/${UPDATE_ID}.map`]: encodeJson({
            version: 3,
            sources: [longSource],
            mappings: "AAAA",
          }),
        },
      });
      const stack = "Error: x\n    at render (address at index.android.bundle:1:0)";
      yield* harness.send(ingest("logs", exceptionLogs(stack, stack)));
      const payload = decodeJson(sentText(harness.sent[0]!)) as {
        resourceLogs: Array<{
          scopeLogs: Array<{
            logRecords: Array<{
              attributes: Array<{ key: string; value: { stringValue: string } }>;
            }>;
          }>;
        }>;
      };
      const statuses = payload.resourceLogs[0]!.scopeLogs[0]!.logRecords.map(
        (record) =>
          record.attributes.find(({ key }) => key === "relay.symbolication.status")?.value
            .stringValue,
      );
      expect(statuses).toEqual(["symbolicated", "no_bundle_frames"]);
    }),
  );

  it.effect("looks up at most two bundles' maps per request", () =>
    Effect.gen(function* () {
      const updateIds = ["update-1", "update-2", "update-3"];
      const harness = yield* makeHarness({
        objects: Object.fromEntries(updateIds.map((id) => [`android/ota/${id}.map`, SOURCE_MAP])),
      });
      const stack = "Error: x\n    at render (address at index.android.bundle:1:12)";
      yield* harness.send(
        ingest(
          "logs",
          encodeJson({ resourceLogs: updateIds.map((id) => exceptionResourceLogs(id, [stack])) }),
        ),
      );
      expect(harness.objectLookups).toEqual([
        "android/ota/update-1.map",
        "android/ota/update-2.map",
      ]);
      const payload = decodeJson(sentText(harness.sent[0]!)) as {
        resourceLogs: Array<{
          scopeLogs: Array<{
            logRecords: Array<{
              attributes: Array<{ key: string; value: { stringValue: string } }>;
            }>;
          }>;
        }>;
      };
      const statuses = payload.resourceLogs.map(
        (resourceLogs) =>
          resourceLogs.scopeLogs[0]!.logRecords[0]!.attributes.find(
            ({ key }) => key === "relay.symbolication.status",
          )?.value.stringValue,
      );
      expect(statuses).toEqual(["symbolicated", "symbolicated", "source_map_missing"]);
    }),
  );

  it.effect("forwards the stack untouched and says why when no map is stored", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const stack = "Error: x\n    at render (address at index.android.bundle:1:12)";
      yield* harness.send(ingest("logs", exceptionLogs(stack)));
      expect(forwardedStack(harness.sent[0]!)).toMatchObject({
        "exception.stacktrace": stack,
        "relay.symbolication.status": "source_map_missing",
      });
    }),
  );

  it.effect("skips a stored map too large to decode, without reading it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        objects: {
          [`android/ota/${UPDATE_ID}.map`]: { size: MobileTelemetry.MAX_SOURCE_MAP_BYTES + 1 },
        },
      });
      const stack = "Error: x\n    at render (address at index.android.bundle:1:12)";
      const response = yield* harness.send(ingest("logs", exceptionLogs(stack)));
      expect(response.status).toBe(200);
      expect(forwardedStack(harness.sent[0]!)).toMatchObject({
        "exception.stacktrace": stack,
        "relay.symbolication.status": "source_map_missing",
      });
    }),
  );

  it.effect("passes Axiom's status and Retry-After back for Observe's retries", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
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

  it.effect("answers 502 when Axiom cannot be reached", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        execute: (request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            }),
          ),
      });
      const response = yield* harness.send(ingest("logs", "{}"));
      expect(response.status).toBe(502);
    }),
  );

  it.effect("answers upstream_timeout before the relay's request deadline cuts it off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ execute: () => Effect.never });
      const fiber = yield* harness.send(ingest("logs", "{}")).pipe(Effect.forkChild);
      yield* TestClock.adjust(RelayHttpApi.RELAY_REQUEST_DEADLINE_MS - 1);
      const response = yield* Fiber.join(fiber);
      expect(response.status).toBe(504);
    }),
  );

  it.effect("refuses bad paths, oversized bodies, and rate-limited clients", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect((yield* harness.send(ingest("logs", "{}", "not-a-project"))).status).toBe(404);
      const tooLarge = "x".repeat(MobileTelemetry.MOBILE_TELEMETRY_MAX_BODY_BYTES + 1);
      expect((yield* harness.send(ingest("logs", tooLarge))).status).toBe(413);
      expect(harness.sent).toEqual([]);

      const limited = yield* makeHarness({ allow: false });
      const response = yield* limited.send(ingest("logs", "{}"));
      expect(response.status).toBe(429);
      expect(limited.sent).toEqual([]);
    }),
  );
});
