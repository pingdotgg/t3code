import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { expectUrlContains } from "../Utils/Http.ts";
import Stack from "./fixtures/do-abort/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

let bust = 0;
const getJson = <T>(
  client: HttpClient.HttpClient,
  url: string,
): Effect.Effect<T, unknown> =>
  client
    .get(`${url}?cb=${Date.now()}-${bust++}`)
    .pipe(Effect.flatMap((res) => res.json as Effect.Effect<T>));

describe.skipIf(!!process.env.FAST)(
  "DurableObjectState.abort resets the isolate",
  () => {
    test(
      "abort resets the Durable Object so the constructor re-runs",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const client = yield* HttpClient.HttpClient;

        yield* expectUrlContains(`${url}/ping`, `"ok":true`, {
          label: "abort worker propagation",
        });

        const before = yield* getJson<{ boots: number; ok: true }>(
          client,
          `${url}/ping`,
        );
        expect(before.ok).toBe(true);
        expect(before.boots).toBeGreaterThanOrEqual(1);

        yield* expectUrlContains(`${url}/abort`, "aborted", {
          label: "abort RPC",
        });

        const after = yield* getJson<{ boots: number; ok: true }>(
          client,
          `${url}/ping`,
        );
        expect(after.boots).toBe(before.boots + 1);
      }).pipe(logLevel),
      { timeout: 180_000 },
    );
  },
);
