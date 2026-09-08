import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { expectUrlContains } from "../Utils/Http.ts";
import HttpServerWorker, {
  readyMarker,
  sensitiveContext,
} from "./fixtures/http-server-worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const Stack = Alchemy.Stack(
  "WorkersHttpServerStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* HttpServerWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/**
 * GET `url` until it serves `status` with an empty body. Both error routes
 * respond with no body, which also distinguishes them from the workers.dev
 * placeholder page (a 404 *with* a body) during edge propagation.
 */
const getEmptyResponse = (url: string, status: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    const body = yield* response.text;
    if (response.status !== status || body !== "") {
      return yield* Effect.fail(
        new Error(
          `expected empty ${status} from ${url}, got ${response.status}: ${body.slice(0, 160)}`,
        ),
      );
    }
    return response;
  }).pipe(
    Effect.retry({ schedule: Schedule.spaced("1500 millis"), times: 20 }),
  );

test(
  "a Respondable defect keeps its intended response over the wire",
  Effect.gen(function* () {
    const { url } = yield* stack;
    yield* expectUrlContains(url, readyMarker);

    yield* getEmptyResponse(`${url}/missing`, 404);
  }),
  { timeout: 180_000 },
);

test(
  "a failed handler responds 500 without exposing the cause",
  Effect.gen(function* () {
    const { url } = yield* stack;
    yield* expectUrlContains(url, readyMarker);

    const response = yield* getEmptyResponse(`${url}/boom`, 500);
    const wireResponse = JSON.stringify(response.headers);
    for (const sensitiveValue of sensitiveContext) {
      expect(wireResponse).not.toContain(sensitiveValue);
    }
  }),
  { timeout: 180_000 },
);
