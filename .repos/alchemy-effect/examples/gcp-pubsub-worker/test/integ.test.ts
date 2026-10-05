import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as run from "@distilled.cloud/gcp/run_v2";
import { describe, expect } from "bun:test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GCP.providers(),
  state: Alchemy.localState(),
});

const { getWhenReady } = Test;

// Out-of-band calls to the Google APIs resolve the same stored credentials
// the deploy uses, so the test runs against the configured profile.
const GcpHttp = Layer.mergeAll(
  GCP.GcpAuth,
  GCP.fromAuthProvider(),
  FetchHttpClient.layer,
);

// Both hosts are built from `main`, which needs a local image build.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status ===
  0;

// Deploy, tests and destroy all sit behind the same Docker guard.
describe.skipIf(!dockerAvailable)("gcp-pubsub-worker", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

  /** Pull subscriptions the worker's event source created on the topic. */
  const subscriptionsOf = (topic: string) =>
    pubsub.listProjectsTopicsSubscriptions({ topic }).pipe(
      Effect.map((page) => page.subscriptions ?? []),
      Effect.provide(GcpHttp),
    );

  let subscriptions: string[] = [];

  /** Poll until a deleted resource reads as `NotFound`. */
  const expectGone = <E, R>(
    what: string,
    status: Effect.Effect<"found" | "gone", E, R>,
  ) =>
    status.pipe(
      // Deletes can take a few seconds to become visible.
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (status) => status === "gone",
        times: 12,
      }),
      Effect.tap((status) =>
        Effect.sync(() => expect(`${what}: ${status}`).toBe(`${what}: gone`)),
      ),
    );

  const found = Effect.as("found" as const);
  const gone = () => Effect.succeed("gone" as const);

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const outputs = yield* stack;
      yield* destroy(Stack);
      if (outputs === undefined) return;

      yield* expectGone(
        "worker pool",
        run
          .getProjectsLocationsWorkerPools({ name: outputs.workerPoolName })
          .pipe(
            found,
            Effect.catchTag("NotFound", gone),
            Effect.provide(GcpHttp),
          ),
      );
      yield* expectGone(
        "topic",
        pubsub
          .getProjectsTopics({ topic: outputs.topicName })
          .pipe(
            found,
            Effect.catchTag("NotFound", gone),
            Effect.provide(GcpHttp),
          ),
      );
      for (const subscription of subscriptions) {
        yield* expectGone(
          subscription,
          pubsub
            .getProjectsSubscriptions({ subscription })
            .pipe(
              found,
              Effect.catchTag("NotFound", gone),
              Effect.provide(GcpHttp),
            ),
        );
      }
      yield* expectGone(
        "database",
        firestore
          .getProjectsDatabases({ name: outputs.databaseName })
          .pipe(
            found,
            Effect.catchTag("NotFound", gone),
            Effect.provide(GcpHttp),
          ),
      );
    }),
    { timeout: 600_000 },
  );

  const baseUrlOf = (url: string | undefined) => {
    if (url === undefined) throw new Error("the service has no URL");
    return url.replace(/\/+$/, "");
  };

  interface JobStatus {
    id: string;
    status: "pending" | "done";
    sha256?: string;
    words?: number;
    chars?: number;
  }

  class UnexpectedStatus extends Data.TaggedError("UnexpectedStatus")<{
    status: number;
    body: string;
  }> {}

  const statusOf = (baseUrl: string, id: string) =>
    Effect.gen(function* () {
      const res = yield* HttpClient.execute(
        HttpClientRequest.get(`${baseUrl}/jobs/${id}`),
      );
      if (res.status !== 200 && res.status !== 202) {
        return yield* new UnexpectedStatus({
          status: res.status,
          body: yield* res.text,
        });
      }
      return (yield* res.json) as unknown as JobStatus;
    });

  const PAYLOADS = [
    "hello world",
    "the quick brown fox jumps over the lazy dog",
    "  alchemy   on   google cloud  ",
    "one",
    "",
  ];

  test(
    "rejects a job without a string payload",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      const res = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/jobs`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ payload: 42 }),
        ),
      );
      expect(res.status).toBe(400);
    }),
    { timeout: 120_000 },
  );

  test(
    "processes submitted jobs through Pub/Sub into Firestore",
    Effect.gen(function* () {
      const { url, topicName, databaseName } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      subscriptions = yield* subscriptionsOf(topicName);
      expect(subscriptions.length).toBe(1);

      const ids: string[] = [];
      for (const payload of PAYLOADS) {
        const res = yield* HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/jobs`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ payload }),
          ),
        );
        expect(res.status).toBe(202);
        const body = (yield* res.json) as unknown as JobStatus;
        expect(body.status).toBe("pending");
        ids.push(body.id);
      }

      // The worker pool's first pull, and project-level Firestore grants on
      // a fresh deploy, can each take a few minutes. Until then the API
      // answers 202 pending — or 500 while its own read grant propagates.
      const results = yield* Effect.forEach(ids, (id) =>
        statusOf(baseUrl, id).pipe(
          Effect.tapError((error) => Effect.logWarning(error)),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (status) => status.status === "done",
            times: 48,
          }),
        ),
      );

      for (const [i, payload] of PAYLOADS.entries()) {
        const expected = {
          id: ids[i],
          status: "done",
          sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
          words: payload.split(/\s+/).filter(Boolean).length,
          chars: payload.length,
        };
        expect(results[i]).toMatchObject(expected);

        // The result the API served is a real Firestore document.
        const document = yield* firestore
          .getProjectsDatabasesDocuments({
            name: `${databaseName}/documents/jobs/${ids[i]}`,
          })
          .pipe(Effect.provide(GcpHttp));
        expect(document.fields?.status?.stringValue).toBe("done");
        expect(document.fields?.sha256?.stringValue).toBe(expected.sha256);
        expect(Number(document.fields?.words?.integerValue)).toBe(
          expected.words,
        );
      }
    }),
    { timeout: 900_000 },
  );
});
