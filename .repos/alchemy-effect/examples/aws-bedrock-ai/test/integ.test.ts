import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "generates text through Bedrock",
  Effect.gen(function* () {
    const out = (yield* stack) as { url: string };
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    // Fresh function URLs take a few seconds to start serving 200s.
    const res = yield* client
      .get(`${out.url}?prompt=${encodeURIComponent("Say pong.")}`)
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("1 second"),
          times: 10,
        }),
      );
    const body = (yield* res.json) as { text: string; finishReason: string };
    expect(body.text.length).toBeGreaterThan(0);
  }),
  { timeout: 300_000 },
);
