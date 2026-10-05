import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { spawnSync } from "node:child_process";
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

// Both services are built from `main`, which needs a local image build.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status ===
  0;

// Deploy, tests and destroy all sit behind the same Docker guard.
describe.skipIf(!dockerAvailable)("gcp-service-to-service", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

  const serviceState = (name: string) =>
    cloudrun.getProjectsLocationsServices({ name }).pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.orDie,
      Effect.provide(GcpHttp),
    );

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const { gatewayName, quotesName } = yield* stack;
      yield* destroy(Stack);
      // Nothing is left behind: both Cloud Run services are gone.
      expect(yield* serviceState(gatewayName)).toEqual("gone");
      expect(yield* serviceState(quotesName)).toEqual("gone");
    }),
    { timeout: 600_000 },
  );

  const baseUrlOf = (url: string | undefined) => {
    if (url === undefined) throw new Error("the service has no URL");
    return url.replace(/\/+$/, "");
  };

  const status = (url: string) =>
    HttpClient.get(url).pipe(Effect.map((response) => response.status));

  test(
    "the gateway is public",
    Effect.gen(function* () {
      const { url } = yield* stack;
      expect(url).toMatch(/^https:\/\//);
      const res = yield* getWhenReady(`${baseUrlOf(url)}/`);
      expect(res.status).toBe(200);
    }),
    { timeout: 120_000 },
  );

  test(
    "the quotes service rejects callers without a Google identity",
    Effect.gen(function* () {
      const { quotesUrl } = yield* stack;
      const code = yield* status(`${baseUrlOf(quotesUrl)}/quote`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (code) => code === 403,
          times: 12,
        }),
      );
      expect(code).toBe(403);
    }),
    { timeout: 120_000 },
  );

  test(
    "GET /quote on the gateway is served by the private quotes service",
    Effect.gen(function* () {
      const { url, quotesName, gatewayServiceAccount } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* getWhenReady(`${baseUrl}/`);

      // run.invoker lands on the quotes service's own policy, for the
      // gateway's runtime service account only.
      const policy = yield* cloudrun
        .getIamPolicyProjectsLocationsServices({ resource: quotesName })
        .pipe(Effect.orDie, Effect.provide(GcpHttp));
      const invokers =
        policy.bindings?.find((binding) => binding.role === "roles/run.invoker")
          ?.members ?? [];
      expect(invokers).toEqual([`serviceAccount:${gatewayServiceAccount}`]);

      // A fresh run.invoker grant can take a moment to reach Cloud Run's
      // front end; until then the gateway relays the 403.
      const response = yield* HttpClient.get(`${baseUrl}/quote?n=1`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (response) => response.status !== 403,
          times: 24,
        }),
      );
      expect(response.status).toBe(200);
      expect(yield* response.json).toEqual({
        index: 1,
        quote: "Make it work, make it right, make it fast. — Kent Beck",
        servedBy: "quotes",
      });
    }),
    { timeout: 180_000 },
  );
});
