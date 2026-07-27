import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Test from "@/Test/Alchemy";
import * as keyspacesstreams from "@distilled.cloud/aws/keyspacesstreams";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

import KeyspacesStreamsTestFunctionLive, {
  KeyspacesStreamsTestFunction,
} from "./streams-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

// keyspacesstreams is a data-plane read API over CDC streams of Keyspaces
// tables. The ungated probes assert the distilled wiring surfaces typed
// errors; the live traverse (which needs a CDC-enabled table + a deployed
// Lambda exercising the TableStreams binding) is gated behind
// AWS_TEST_SLOW=1.
describe("AWS.Keyspaces.TableStreams", () => {
  test.provider(
    "getStream on a nonexistent stream yields a typed error",
    (_stack) =>
      Effect.gen(function* () {
        const { accountId, region } = yield* AWSEnvironment.current;
        const error = yield* keyspacesstreams
          .getStream({
            streamArn: `arn:aws:cassandra:${region}:${accountId}:/keyspace/alchemy_nonexistent_ks/table/nonexistent_tbl/stream/2024-01-01T00:00:00.000`,
          })
          .pipe(Effect.flip);
        expect(["ResourceNotFoundException", "ValidationException"]).toContain(
          error._tag,
        );
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "listStreams on a nonexistent table returns an empty stream list",
    (_stack) =>
      Effect.gen(function* () {
        // The API treats an unknown keyspace/table as "no streams" rather
        // than ResourceNotFound — the round-trip proves the distilled
        // wiring decodes ListStreamsOutput.
        const listed = yield* keyspacesstreams.listStreams({
          keyspaceName: "alchemy_nonexistent_ks",
          tableName: "nonexistent_tbl",
        });
        expect(listed.streams ?? []).toHaveLength(0);
      }),
    { timeout: 60_000 },
  );

  test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
    "CDC table exposes latestStreamArn and Lambda traverses the stream via the binding",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const { functionUrl } = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* KeyspacesStreamsTestFunction;
          }).pipe(Effect.provide(KeyspacesStreamsTestFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const baseUrl = functionUrl!.replace(/\/+$/, "");

        // Out-of-band: the CDC stream is enumerable via distilled directly.
        const listed = yield* keyspacesstreams.listStreams({
          keyspaceName: "alchemy_streams_test_ks",
          tableName: "orders",
        });
        expect((listed.streams ?? []).length).toBeGreaterThanOrEqual(1);

        // Drive the deployed Lambda through the TableStreams binding —
        // proves the cassandra:* stream IAM actions and the client wiring.
        // Retry through function-URL cold start / IAM propagation.
        const body = yield* HttpClient.get(`${baseUrl}/traverse`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : Effect.fail(
                  new Error(`traverse not ready: ${response.status}`),
                ),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.exponential("1 second"),
              Schedule.recurs(8),
            ]),
          }),
        );
        const traverse = body as {
          streamArn: string;
          streamStatus: string;
          viewType: string;
          shardCount: number;
          recordCount: number;
        };
        expect(traverse.streamArn).toContain("/stream/");
        expect(["ENABLED", "ENABLING"]).toContain(traverse.streamStatus);
        expect(traverse.viewType).toBe("NEW_AND_OLD_IMAGES");
        expect(traverse.shardCount).toBeGreaterThanOrEqual(1);
        // Idle table — no writes were made, so no change records.
        expect(traverse.recordCount).toBeGreaterThanOrEqual(0);

        yield* stack.destroy();
      }),
    { timeout: 900_000 },
  );
});
