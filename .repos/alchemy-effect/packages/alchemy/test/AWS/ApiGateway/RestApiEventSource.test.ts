import * as AWS from "@/AWS";
import { deleteRestApiAndWait } from "@/AWS/ApiGateway/common.ts";
import { AWSEnvironment } from "@/AWS/Environment";
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

// Fresh function URLs + stage propagation + the Lambda invoke permission
// can take 30–90s to serve; cap exponential backoff at 10s so we keep a
// steady cadence.
const readinessSchedule = Schedule.max([
  Schedule.exponential(500).pipe(
    Schedule.modifyDelay(({ duration: d }) =>
      Effect.succeed(
        Duration.isGreaterThan(d, Duration.seconds(10))
          ? Duration.seconds(10)
          : d,
      ),
    ),
  ),
  Schedule.recurs(20),
]);

const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`GET ${url} returned ${response.status}`)),
    ),
  );

// The RestApi's physical name is deterministic
// (`{stack}-{logicalId}-{stage}-{suffix}`), so the deployed API is
// discoverable out-of-band by the `-{logicalId}-test-` marker. Used both to
// find the API under test and to reap strays from a previous killed run
// (`deleteRestApi` is throttled account-wide, so a killed vitest process can
// strand the API).
const findRestApis = (logicalId: string) =>
  ag.getRestApis.pages({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).flatMap((page) =>
        (page.items ?? []).filter(
          (api): api is ag.RestApi & { id: string } =>
            api.id != null &&
            (api.name?.includes(`-${logicalId}-test-`) ?? false),
        ),
      ),
    ),
  );

const reapRestApis = (logicalId: string) =>
  findRestApis(logicalId).pipe(
    Effect.flatMap(Effect.forEach((api) => deleteRestApiAndWait(api.id))),
    Effect.asVoid,
    Effect.orDie,
  );

class RestApiNotVisible extends Data.TaggedError("RestApiNotVisible") {}

test.provider.skipIf(!!process.env.FAST)(
  "onRestApiRoute serves REST routes from the hosting Lambda",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* reapRestApis("AgEsApi");
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
        Effect.flatMap(
          (response): Effect.Effect<void, Error> =>
            response.status === 200
              ? Effect.void
              : Effect.fail(new Error(`probe returned ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessSchedule }),
      );

      // Discover the REST API out-of-band by its deterministic name.
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

      // Zero-orphan proof: the deterministically named REST API is gone.
      const leftover = yield* findRestApis("AgEsApi");
      expect(leftover).toHaveLength(0);
    }).pipe(Effect.ensuring(reapRestApis("AgEsApi"))),
  { timeout: 600_000 },
);
