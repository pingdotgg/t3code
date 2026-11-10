import { expect } from "bun:test";
import * as Fly from "@alchemy.run/fly";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";
import { USERS } from "../src/users.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Fly.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((res) =>
      res.status === 200 ? res.json : Effect.fail(new Error(`HTTP ${res.status}`)),
    ),
    Effect.retry({
      // Back off, but keep polling every 3s: a new fly.dev hostname can take
      // a minute or more to start serving.
      schedule: Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("3 seconds")]),
      times: 35,
    }),
  );

const stack = beforeAll(deploy(Stack), { timeout: 400_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 240_000,
});

test(
  "the public gateway reaches private Services over the stack network",
  Effect.gen(function* () {
    const out = yield* stack;
    expect(out.url).toMatch(/^https:\/\/.+\.fly\.dev$/);
    expect(out.usersUrl).toBeUndefined();
    expect(out.usersPrivateUrl).toMatch(/^http:\/\/.+\.flycast$/);
    expect(out.ordersPrivateUrl).toMatch(/^http:\/\/.+\.flycast$/);
    expect(out.network).toBeString();

    expect((yield* getJson(`${out.url}/users`)) as unknown).toEqual(USERS);
    const orders = (yield* getJson(`${out.url}/orders`)) as Array<{
      user: { name: string };
    }>;
    expect(orders.map((order) => order.user.name)).toEqual(["Ada", "Grace"]);
  }),
  { timeout: 240_000 },
);
