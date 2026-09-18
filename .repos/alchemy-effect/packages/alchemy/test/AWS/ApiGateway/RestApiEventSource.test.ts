import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import { createInternalTags, hasTags } from "@/Tags.ts";
import * as Test from "./Test.ts";
import * as ag from "@distilled.cloud/aws/api-gateway";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import RestApiEventSourceFunctionLive, {
  RestApiEventSourceFunction,
} from "./fixtures/rest-api-event-source-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Allow bounded propagation of function URLs, stages, and invoke permissions.
const readinessSchedule = Schedule.max([
  Schedule.exponential(500).pipe(
    Schedule.modifyDelay(({ duration: d }) =>
      Effect.succeed(
        Duration.isGreaterThan(d, Duration.seconds(5))
          ? Duration.seconds(5)
          : d,
      ),
    ),
  ),
  Schedule.recurs(10),
]);

const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`GET ${url} returned ${response.status}`)),
    ),
  );

// Ownership tags survive name truncation and isolate concurrent test stages.
const findRestApis = Effect.fn(function* (logicalId: string) {
  const tags = yield* createInternalTags(logicalId);
  return yield* ag.getRestApis.pages({}).pipe(
    Stream.runCollect,
    Effect.map((pages) =>
      Array.from(pages).flatMap((page) =>
        (page.items ?? []).filter(
          (api): api is ag.RestApi & { id: string } =>
            api.id != null && hasTags(tags, api.tags),
        ),
      ),
    ),
  );
});

class RestApiNotVisible extends Data.TaggedError("RestApiNotVisible") {}

test.provider.skipIf(!!process.env.FAST)(
  "onRestApiRoute serves REST routes from the hosting Lambda",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { region } = yield* AWSEnvironment.current;

      const { functionUrl } = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* RestApiEventSourceFunction;
        }).pipe(Effect.provide(RestApiEventSourceFunctionLive)),
      );
      expect(functionUrl).toBeTruthy();
      const baseUrl = functionUrl!.replace(/\/+$/, "");

      // Wait for the function URL to serve — the readiness signal that the
      // Lambda (and everything deployed with it) is live.
      yield* HttpClient.get(`${baseUrl}/`).pipe(
        Effect.flatMap((response): Effect.Effect<void, Error> =>
          response.status === 200
            ? Effect.void
            : Effect.fail(new Error(`probe returned ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessSchedule }),
      );

      // Discover the REST API without awaiting outputs inside its host.
      const apis = yield* findRestApis("AgEsApi").pipe(
        Effect.filterOrFail(
          (found) => found.length === 1,
          () => new RestApiNotVisible(),
        ),
        Effect.retry({
          while: (e): boolean => e._tag === "RestApiNotVisible",
          schedule: Schedule.spaced("3 seconds"),
          times: 10,
        }),
      );
      const invokeUrl = `https://${apis[0].id}.execute-api.${region}.amazonaws.com/test`;

      // GET /items — the event source dispatched the proxy event to the
      // registered handler.
      const items = (yield* getJson(`${invokeUrl}/items`).pipe(
        Effect.retry({ schedule: readinessSchedule }),
      )) as { items: string[] };
      expect(items.items).toEqual(["alpha", "beta"]);

      // POST /echo — method, resource path, and body arrive intact.
      const echoed = (yield* HttpClient.execute(
        HttpClientRequest.post(`${invokeUrl}/echo`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ hello: "world" }),
        ),
      ).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`POST /echo returned ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessSchedule }),
      )) as { method: string; resource: string; echoed: { hello: string } };
      expect(echoed.method).toBe("POST");
      expect(echoed.resource).toBe("/echo");
      expect(echoed.echoed).toEqual({ hello: "world" });

      // Unregistered verb on a registered path is rejected by API Gateway
      // itself (403 MissingAuthenticationToken) rather than the handler.
      const missing = yield* HttpClient.execute(
        HttpClientRequest.make("DELETE")(`${invokeUrl}/items`),
      );
      expect(missing.status).toBeGreaterThanOrEqual(400);

      yield* stack.destroy();

      const deleted = yield* ag
        .getRestApi({ restApiId: apis[0].id })
        .pipe(
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );
      expect(deleted).toBeUndefined();
      const leftover = yield* findRestApis("AgEsApi");
      expect(leftover).toHaveLength(0);
    }),
  { timeout: 120_000 },
);
