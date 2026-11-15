import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { makeBoatApi } from "./boatCloudApi.ts";

const commandResult = { exitCode: 0, stdout: "ok" };

describe("BoatApi.exec", () => {
  it.effect("does not resend a command after the connection drops", () =>
    Effect.gen(function* () {
      let requests = 0;
      const http = HttpClient.make((request) =>
        Effect.suspend(() => {
          requests += 1;
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: new Error("reset") }),
            }),
          );
        }),
      );
      const error = yield* Effect.flip(makeBoatApi(http, "key").exec("box", "echo hi"));
      assert.strictEqual(error.code, "network");
      assert.strictEqual(requests, 1);
    }),
  );

  it.effect("retries a command Boat refused because the VM was still starting", () =>
    Effect.gen(function* () {
      let requests = 0;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests += 1;
          return HttpClientResponse.fromWeb(
            request,
            requests === 1
              ? Response.json({ code: "sandbox_starting", message: "starting" }, { status: 409 })
              : Response.json(commandResult),
          );
        }),
      );
      const fiber = yield* Effect.forkChild(makeBoatApi(http, "key").exec("box", "echo hi"));
      yield* TestClock.adjust("2 seconds");
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.stdout, "ok");
      assert.strictEqual(requests, 2);
    }),
  );
});
