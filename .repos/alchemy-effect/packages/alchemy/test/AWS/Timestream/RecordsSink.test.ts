import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import TimestreamSinkFunctionLive, {
  TimestreamSinkFunction,
} from "./sink-handler";

const { test } = Test.make({ providers: AWS.providers() });

const postJson = (baseUrl: string, pathname: string, body: unknown) =>
  HttpClient.execute(
    HttpClientRequest.post(`${baseUrl}${pathname}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  ).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.succeed(response)
        : Effect.fail(new Error(`${pathname} not ready: ${response.status}`)),
    ),
    // Retry through function-URL cold start / IAM propagation.
    Effect.retry({
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(8),
      ]),
    }),
  );

const countForHost = (baseUrl: string, host: string) =>
  HttpClient.get(`${baseUrl}/count?host=${host}`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`count failed: ${response.status}`)),
    ),
    Effect.map((body) =>
      Number(
        (body as { rows: Array<{ Data: Array<{ ScalarValue?: string }> }> })
          .rows[0]?.Data[0]?.ScalarValue ?? "0",
      ),
    ),
  );

// Amazon Timestream for LiveAnalytics is closed to new AWS customers; the
// testing account receives the typed `TimestreamNotOnboarded` gate on every
// operation (asserted ungated in Database.test.ts). The sink E2E — stream
// records through RecordsSink, read them back out-of-band via the Query
// binding — is therefore gated behind AWS_TEST_TIMESTREAM=1 so an onboarded
// account can run it unchanged.
describe("AWS.Timestream.RecordsSink", () => {
  test.provider.skipIf(!process.env.AWS_TEST_TIMESTREAM)(
    "Lambda streams records through the sink; rejected records are dropped",
    (stack) =>
      Effect.gen(function* () {
        const { functionUrl } = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* TimestreamSinkFunction;
          }).pipe(Effect.provide(TimestreamSinkFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const baseUrl = functionUrl!.replace(/\/+$/, "");

        // 150 records > the 100-record WriteRecords limit, so the sink must
        // split the stream into two sequential batches.
        yield* postJson(baseUrl, "/sink", { host: "sink-bulk", count: 150 });

        // Memory-store writes are queryable near-immediately; retry a few
        // times regardless.
        const bulkCount = yield* countForHost(baseUrl, "sink-bulk").pipe(
          Effect.flatMap((count) =>
            count >= 150
              ? Effect.succeed(count)
              : Effect.fail(new Error(`only ${count} rows counted yet`)),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.spaced("2 seconds"),
              Schedule.recurs(10),
            ]),
          }),
        );
        expect(bulkCount).toBe(150);

        // Partial failure: the out-of-retention record is permanently
        // rejected (RejectedRecordsException); the sink drops it, lands the
        // two valid records, and the handler still returns 200.
        yield* postJson(baseUrl, "/sink-rejects", { host: "sink-rejects" });

        const rejectsCount = yield* countForHost(baseUrl, "sink-rejects").pipe(
          Effect.flatMap((count) =>
            count >= 2
              ? Effect.succeed(count)
              : Effect.fail(new Error(`only ${count} rows counted yet`)),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.spaced("2 seconds"),
              Schedule.recurs(10),
            ]),
          }),
        );
        expect(rejectsCount).toBe(2);

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});
