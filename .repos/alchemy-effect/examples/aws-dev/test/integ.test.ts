/**
 * LIVE counterpart to test/dev.test.ts: deploys the exact same fixture to
 * real AWS (Test.make + deploy, no CLI) and drives the same HTTP routes
 * against the real Function URL. Together the two suites pin that every
 * binding AND every event-source glue resource (SNS Subscription, Lambda
 * invoke Permission, stream/queue EventSourceMappings) behaves identically
 * in `alchemy dev` (floci) and a live deploy.
 *
 * Requires AWS credentials (run under `--profile testing` / test:examples).
 */
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const api = Effect.gen(function* () {
  const out = (yield* stack) as { api: string };
  return out.api;
});

/** GET a route, retrying while the fresh Function URL warms up. */
const getJson = Effect.fn(function* (path: string) {
  const url = yield* api;
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const res = yield* client.get(new URL(path, url).toString()).pipe(
    Effect.retry({
      schedule: Schedule.exponential("1 second"),
      times: 10,
    }),
  );
  return yield* res.json;
});

/** POST a JSON body to a route, with the same warm-up retry. */
const postJson = Effect.fn(function* (path: string, body: unknown) {
  const url = yield* api;
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const res = yield* client
    .execute(
      HttpClientRequest.post(new URL(path, url).toString()).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    )
    .pipe(
      Effect.retry({
        schedule: Schedule.exponential("1 second"),
        times: 10,
      }),
    );
  return yield* res.json;
});

/** Poll a `{ body }` read route until the async consumer has recorded. */
const pollBody = (path: string) =>
  getJson(path).pipe(
    Effect.map((json) => (json as { body: string | null }).body),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (body) => body !== null,
      times: 90,
    }),
  );

test(
  "serves marker and env through the live Function URL",
  Effect.gen(function* () {
    const home = (yield* getJson("/")) as { marker: string; variable: string };
    expect(home.marker).toBe("aws-dev-marker-v1");
    expect(home.variable).toBe("my-variable-abc123");
  }),
  { timeout: 120_000 },
);

test(
  "S3 binding roundtrips",
  Effect.gen(function* () {
    const s3 = (yield* getJson("/s3")) as { text: string };
    expect(s3.text).toBe("hello from s3");
  }),
  { timeout: 120_000 },
);

test(
  "DynamoDB binding roundtrips",
  Effect.gen(function* () {
    const dynamo = (yield* getJson("/dynamo")) as { text: string | null };
    expect(dynamo.text).toBe("hello from dynamo");
  }),
  { timeout: 120_000 },
);

test(
  "SQS produce is delivered to the queue consumer",
  Effect.gen(function* () {
    const message = { id: crypto.randomUUID(), text: "hello from live sqs" };
    yield* postJson("/queue/send", message);
    const body = yield* pollBody(`/queue/messages?id=${message.id}`);
    expect(JSON.parse(body!)).toEqual(message);
  }),
  { timeout: 240_000 },
);

test(
  "SNS publish is delivered through the Subscription + Permission glue",
  Effect.gen(function* () {
    const notification = {
      id: crypto.randomUUID(),
      text: "hello from live sns",
    };
    yield* postJson("/topic/send", notification);
    const body = yield* pollBody(`/topic/messages?id=${notification.id}`);
    expect(JSON.parse(body!)).toEqual(notification);
  }),
  { timeout: 240_000 },
);

test(
  "table writes are delivered through the stream EventSourceMapping",
  Effect.gen(function* () {
    const itemId = crypto.randomUUID();
    yield* postJson("/items", { id: itemId });
    const body = yield* pollBody(`/changes?id=${itemId}`);
    expect(body).toBe("INSERT");
  }),
  { timeout: 240_000 },
);
