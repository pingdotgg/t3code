import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import { makeLocalActivityProbe } from "./LocalActivityProbe.ts";

const makeHttpClient = (status: number, body: string) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
  );

const makeInput = (httpClient: HttpClient.HttpClient) => ({
  pool: {
    list: Effect.succeed([
      {
        id: PRIMARY_LOCAL_ENVIRONMENT_ID,
        currentConfig: Effect.succeed(Option.some({ httpBaseUrl: "http://127.0.0.1:1" })),
      },
    ]),
  } as unknown as DesktopBackendPool.DesktopBackendPool["Service"],
  auth: {
    getBearerToken: Effect.succeed("test-token"),
  } as unknown as DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth["Service"],
  httpClient,
});

describe("makeLocalActivityProbe", () => {
  it.effect("counts threads with a live activity from a 2xx snapshot", () =>
    Effect.gen(function* () {
      const body = JSON.stringify({
        threads: [
          { activityRunStatus: "preparing" },
          { activityRunStatus: "starting" },
          { activityRunStatus: "running" },
          { activityRunStatus: "waiting" },
          {},
          null,
        ],
      });
      const count = yield* makeLocalActivityProbe(makeInput(makeHttpClient(200, body)));
      assert.equal(count, 4);
    }),
  );

  it.effect("treats a non-2xx response as idle and logs a warning", () =>
    Effect.gen(function* () {
      const warnings: Array<unknown> = [];
      const capture = Logger.make((options) => {
        warnings.push(options.message);
      });
      const body = JSON.stringify({ error: "unavailable" });
      const count = yield* Effect.withLogger(
        makeLocalActivityProbe(makeInput(makeHttpClient(503, body))),
        capture,
      );
      assert.equal(count, 0);
      assert.include(
        warnings.flat().map(String).join(" "),
        "local activity probe failed",
      );
    }),
  );
});
