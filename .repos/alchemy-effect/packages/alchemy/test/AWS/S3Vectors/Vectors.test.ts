import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import VectorsTestFunctionLive, {
  VectorsTestFunction,
} from "./vectors-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "S3VectorsBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

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
        Schedule.recurs(5),
      ]),
    }),
  );

describe("S3Vectors Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("S3Vectors test setup: destroying previous");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("S3Vectors test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* VectorsTestFunction;
        }).pipe(Effect.provide(VectorsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/ping`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("Vectors", () => {
    test.provider(
      "put + query round-trips through the bound index",
      (_stack) =>
        Effect.gen(function* () {
          // insert
          const putBody = (yield* send(
            HttpClientRequest.get(`${baseUrl}/put`),
          ).pipe(Effect.flatMap((r) => r.json))) as { put: number };
          expect(putBody.put).toBe(3);

          // query nearest to [1,0,0,0] — expect "a" (exact) and "c" (close),
          // retrying through data-plane eventual consistency.
          const queryBody = yield* send(
            HttpClientRequest.get(`${baseUrl}/query`),
          ).pipe(
            Effect.flatMap((r) => r.json),
            Effect.map((b) => b as { keys: string[]; distanceMetric: string }),
            Effect.flatMap((b) =>
              b.keys.includes("a")
                ? Effect.succeed(b)
                : Effect.fail(
                    new Error(`query not ready: ${JSON.stringify(b)}`),
                  ),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.spaced("3 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );
          expect(queryBody.distanceMetric).toBe("cosine");
          expect(queryBody.keys).toContain("a");
          expect(queryBody.keys.length).toBe(2);

          // get by key (read-only client)
          const getBody = (yield* send(
            HttpClientRequest.get(`${baseUrl}/get`),
          ).pipe(Effect.flatMap((r) => r.json))) as { keys: string[] };
          expect(getBody.keys).toContain("a");

          // list keys (read-only client)
          const listBody = (yield* send(
            HttpClientRequest.get(`${baseUrl}/list`),
          ).pipe(Effect.flatMap((r) => r.json))) as { keys: string[] };
          expect(listBody.keys).toContain("a");

          // delete a key (write-only client)
          const delBody = (yield* send(
            HttpClientRequest.get(`${baseUrl}/delete`),
          ).pipe(Effect.flatMap((r) => r.json))) as { deleted: string };
          expect(delBody.deleted).toBe("b");

          // put + get through the composed ReadWrite client
          const rwBody = (yield* send(
            HttpClientRequest.get(`${baseUrl}/rw`),
          ).pipe(Effect.flatMap((r) => r.json))) as { keys: string[] };
          expect(rwBody.keys).toContain("rw");
        }),
      { timeout: 120_000 },
    );
  });
});
