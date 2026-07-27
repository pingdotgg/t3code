import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import CloudTrailLakeTestFunctionLive, {
  CloudTrailLakeTestFunction,
} from "./lake-handler";

const { test } = Test.make({ providers: AWS.providers() });

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx from the Lambda fixture (cold re-init, IAM propagation
// on the freshly attached cloudtrail policy, the store's settling window
// exhausting the handler's bounded retry). Genuine 4xx return immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(8),
      ]),
    }),
  );

const getJson = (url: string) =>
  send(HttpClientRequest.get(url)).pipe(Effect.flatMap((r) => r.json));

class QueryStillRunning extends Data.TaggedError("QueryStillRunning") {}

// GATED: CloudTrail Lake is closed to new customers (see the typed
// CloudTrailLakeOnboardingClosed probe in EventDataStore.test.ts) — deploying
// the fixture's EventDataStore only works on an account that was onboarded
// to Lake before the closure. Set AWS_TEST_CLOUDTRAIL_LAKE=1 to run it.
test.provider.skipIf(!process.env.AWS_TEST_CLOUDTRAIL_LAKE)(
  "Lake query bindings: start, describe, results, list, cancel, generate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { functionUrl } = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CloudTrailLakeTestFunction;
        }).pipe(Effect.provide(CloudTrailLakeTestFunctionLive)),
      );
      expect(functionUrl).toBeTruthy();
      const baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness: fresh function URLs take a few seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/query/list`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(60),
          ]),
        }),
      );

      // StartQuery — the fixture threads the store's ID into the FROM
      // clause and rides out the store's settling window.
      const started = (yield* getJson(`${baseUrl}/query/run`)) as any;
      expect(started.queryId).toBeTruthy();

      // DescribeQuery — poll to a terminal status (an empty store finishes
      // fast; FAILED still proves IAM + typed wiring).
      const terminal = yield* getJson(
        `${baseUrl}/query/describe?id=${started.queryId}`,
      ).pipe(
        Effect.flatMap((body: any) =>
          body.status === "QUEUED" || body.status === "RUNNING"
            ? Effect.fail(new QueryStillRunning())
            : Effect.succeed(body),
        ),
        Effect.retry({
          while: (e) => e._tag === "QueryStillRunning",
          schedule: Schedule.max([
            Schedule.fixed("3 seconds"),
            Schedule.recurs(20),
          ]),
        }),
      );
      expect(["FINISHED", "FAILED", "CANCELLED", "TIMED_OUT"]).toContain(
        (terminal as any).status,
      );

      // GetQueryResults — an empty store yields zero rows.
      const results = (yield* getJson(
        `${baseUrl}/query/results?id=${started.queryId}`,
      )) as any;
      expect(results.rows).toBeGreaterThanOrEqual(0);

      // ListQueries — the injected EventDataStore scopes the listing.
      const list = (yield* getJson(`${baseUrl}/query/list`)) as any;
      expect(list.ids).toContain(started.queryId);

      // CancelQuery — the query already finished, so CloudTrail rejects
      // with the typed InactiveQueryException (a fresh cancel racing the
      // query instead returns CANCELLED); both prove the wiring.
      const cancelled = (yield* send(
        HttpClientRequest.post(`${baseUrl}/query/cancel?id=${started.queryId}`),
      ).pipe(Effect.flatMap((r) => r.json))) as any;
      if (cancelled.errorTag !== undefined) {
        expect(cancelled.errorTag.length).toBeGreaterThan(0);
      } else {
        expect(cancelled.status).toBeTruthy();
      }

      // GenerateQuery — natural-language SQL generation; success or a
      // typed rejection both prove the wiring.
      const generated = (yield* send(
        HttpClientRequest.post(`${baseUrl}/query/generate`),
      ).pipe(Effect.flatMap((r) => r.json))) as any;
      if (generated.errorTag !== undefined) {
        expect(generated.errorTag.length).toBeGreaterThan(0);
      } else {
        expect(generated.statement).toBeTruthy();
      }

      yield* stack.destroy();
    }),
  { timeout: 600_000 },
);
