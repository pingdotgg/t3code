import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import ApiGatewayV2BindingsFunctionLive, {
  ApiGatewayV2BindingsFunction,
} from "./bindings-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Fresh Lambda function URLs return transient errors for the first
// 30–90s (DNS, IAM propagation, cold init). Poll at a steady cadence.
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

const postJson = (url: string) =>
  HttpClient.execute(HttpClientRequest.post(url)).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`POST ${url} returned ${response.status}`)),
    ),
  );

test.provider.skipIf(!!process.env.FAST)(
  "ApiGatewayV2 bindings export the API and reset authorizer caches from a Lambda",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { functionUrl } = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ApiGatewayV2BindingsFunction;
        }).pipe(Effect.provide(ApiGatewayV2BindingsFunctionLive)),
      );
      expect(functionUrl).toBeTruthy();
      const baseUrl = functionUrl!.replace(/\/+$/, "");

      // ExportApi — the live OpenAPI 3.0 document includes the fixture's
      // route (retried through cold start).
      const exported = (yield* getJson(`${baseUrl}/export`).pipe(
        Effect.retry({ schedule: readinessSchedule }),
      )) as { openapi?: string; paths: string[] };
      expect(exported.openapi ?? "").toContain("3.0");
      expect(exported.paths).toContain("/ping");

      // ResetAuthorizersCache — the stage has no authorizer cache, so the
      // API answers 200 (or a typed NotFound the route reports as
      // flushed:false). A missing IAM grant would 500 the route instead.
      const reset = (yield* postJson(`${baseUrl}/reset-authorizers`)) as {
        flushed: boolean;
      };
      expect(typeof reset.flushed).toBe("boolean");

      yield* stack.destroy();
    }),
  { timeout: 600_000 },
);
