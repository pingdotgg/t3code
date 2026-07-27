import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import TimestreamTestFunctionLive, { TimestreamTestFunction } from "./handler";

const { test } = Test.make({ providers: AWS.providers() });

// Amazon Timestream for LiveAnalytics is closed to new AWS customers; the
// testing account receives the typed `TimestreamNotOnboarded` gate on every
// operation (asserted ungated in Database.test.ts). The Lambda E2E — write
// time-series points through the WriteRecords binding, then read them back
// through the Query binding — is therefore gated behind AWS_TEST_TIMESTREAM=1
// so an onboarded account can run it unchanged.
describe("AWS.Timestream Bindings", () => {
  test.provider.skipIf(!process.env.AWS_TEST_TIMESTREAM)(
    "Lambda writes records and queries them back",
    (stack) =>
      Effect.gen(function* () {
        const { functionUrl } = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* TimestreamTestFunction;
          }).pipe(Effect.provide(TimestreamTestFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const baseUrl = functionUrl!.replace(/\/+$/, "");

        // Write a point through the WriteRecords binding. Retry through
        // function-URL cold start / IAM propagation.
        const writeResponse = yield* HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/write`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ host: "web-1", value: "42.0" }),
          ),
        ).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.succeed(response)
              : Effect.fail(new Error(`write not ready: ${response.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.exponential("1 second"),
              Schedule.recurs(8),
            ]),
          }),
        );
        const written = (yield* writeResponse.json) as {
          recordsIngested: { Total?: number } | undefined;
        };
        expect(written.recordsIngested?.Total).toBeGreaterThanOrEqual(1);

        // Query the point back through the Query binding. Memory-store writes
        // are queryable near-immediately; retry a few times regardless.
        const rows = yield* HttpClient.get(`${baseUrl}/query`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : Effect.fail(new Error(`query failed: ${response.status}`)),
          ),
          Effect.map(
            (body) =>
              (
                body as {
                  rows: Array<{ Data: Array<{ ScalarValue?: string }> }>;
                }
              ).rows,
          ),
          Effect.flatMap((rows) =>
            Number(rows[0]?.Data[0]?.ScalarValue ?? "0") >= 1
              ? Effect.succeed(rows)
              : Effect.fail(new Error("no rows counted yet")),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.spaced("2 seconds"),
              Schedule.recurs(10),
            ]),
          }),
        );
        expect(Number(rows[0]!.Data[0]!.ScalarValue)).toBeGreaterThanOrEqual(1);

        // Validate the same SQL through the PrepareQuery binding.
        const prepared = (yield* HttpClient.get(`${baseUrl}/prepare`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : Effect.fail(new Error(`prepare failed: ${response.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.spaced("2 seconds"),
              Schedule.recurs(8),
            ]),
          }),
        )) as { columns: Array<{ Name?: string }> };
        expect(prepared.columns[0]?.Name).toBe("c");

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});
