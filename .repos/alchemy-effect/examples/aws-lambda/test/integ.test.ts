import * as AWS from "alchemy/AWS";
import * as Alchemy from "alchemy";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "deploys and exposes a url",
  Effect.gen(function* () {
    const out = (yield* stack) as unknown;
    const url = typeof out === "string" ? out : (out as { url: string }).url;
    expect(url).toBeString();
  }),
);
