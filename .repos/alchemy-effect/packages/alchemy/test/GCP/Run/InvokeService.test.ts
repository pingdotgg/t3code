import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import { spawnSync } from "node:child_process";
import InvokeCallee from "./fixtures/invoke-callee.ts";
import InvokeCaller from "./fixtures/invoke-caller.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const dockerAvailable = (() => {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 })
        .status === 0
    );
  } catch {
    return false;
  }
})();

interface CallerBody {
  status: number;
  body?: { from: string; method: string; path: string; body: string };
}

/** GET `url`, repeating while the result does not satisfy `until`. */
const getUntil = <A>(
  url: string,
  decode: (status: number, body: string) => A,
  until: (value: A) => boolean,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    return decode(response.status, yield* response.text);
  }).pipe(
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
    // A fresh revision and a fresh run.invoker grant both take a moment
    // to serve; bounded at ~2 minutes.
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until,
      times: 24,
    }),
  );

test.provider.skipIf(!dockerAvailable)(
  "InvokeService calls a private service with a Google-signed ID token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const callee = yield* InvokeCallee;
          const caller = yield* InvokeCaller;
          return {
            callee: {
              name: callee.name,
              uri: callee.uri,
              invokerIamDisabled: callee.invokerIamDisabled,
            },
            caller: {
              name: caller.name,
              uri: caller.uri,
              serviceAccount: caller.serviceAccount,
            },
          };
        }),
      );
      expect(out.callee.invokerIamDisabled).toEqual(false);

      // run.invoker is granted on the callee's own policy, not the project.
      const policy = yield* cloudrun.getIamPolicyProjectsLocationsServices({
        resource: out.callee.name,
      });
      const invokers =
        policy.bindings?.find((binding) => binding.role === "roles/run.invoker")
          ?.members ?? [];
      expect(invokers).toContain(`serviceAccount:${out.caller.serviceAccount}`);

      // Without a token Cloud Run rejects the call at its front end.
      const direct = yield* getUntil(
        `${out.callee.uri}/hello`,
        (status) => status,
        (status) => status === 403,
      );
      expect(direct).toEqual(403);

      const viaCaller = yield* getUntil(
        `${out.caller.uri}/`,
        (status, body) =>
          status === 200 ? (JSON.parse(body) as CallerBody) : { status },
        (value) => value.status === 200,
      );
      expect(viaCaller).toEqual({
        status: 200,
        body: { from: "callee", method: "GET", path: "/hello", body: "" },
      });

      const posted = yield* getUntil(
        `${out.caller.uri}/post`,
        (status, body) =>
          status === 200 ? (JSON.parse(body) as CallerBody) : { status },
        (value) => value.status === 200,
      );
      expect(posted.body).toEqual({
        from: "callee",
        method: "POST",
        path: "/echo",
        body: "ping",
      });

      yield* stack.destroy();

      for (const name of [out.callee.name, out.caller.name]) {
        const gone = yield* cloudrun
          .getProjectsLocationsServices({ name })
          .pipe(
            Effect.as("found" as const),
            Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          );
        expect(gone).toEqual("gone");
      }
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 600_000 },
);
