import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import * as redis from "@distilled.cloud/gcp/redis_v1";
import * as run from "@distilled.cloud/gcp/run_v2";
import { describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { spawnSync } from "node:child_process";
import Stack from "../alchemy.run.ts";
import { LIMIT, WINDOW_SECONDS } from "../src/Api.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GCP.providers(),
  state: Alchemy.localState(),
});

// Out-of-band calls to the Google APIs resolve the same stored credentials
// the deploy uses, so the test runs against the configured profile.
const GcpHttp = Layer.mergeAll(
  GCP.GcpAuth,
  GCP.fromAuthProvider(),
  FetchHttpClient.layer,
);

// The service is built from `main`, which needs a local image build.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status ===
  0;

interface Counter {
  key: string;
  count: number;
  limit: number;
  remaining: number;
  limited: boolean;
  resetInSeconds: number | null;
}

// Deploy, tests and destroy all sit behind the same Docker guard.
describe.skipIf(!dockerAvailable)("gcp-memorystore-redis", () => {
  // Memorystore takes several minutes to create; the image build and the
  // Cloud Run rollout run after it.
  const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const outputs = yield* stack;
      yield* destroy(Stack);
      if (outputs === undefined) return;

      // Destroy waits for the delete operation, so the instance is gone,
      // not just DELETING.
      const instance = yield* redis
        .getProjectsLocationsInstances({ name: outputs.instanceName })
        .pipe(
          Effect.map(() => "present" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.orDie,
          Effect.provide(GcpHttp),
        );
      expect(instance).toBe("gone");

      const service = yield* run
        .getProjectsLocationsServices({ name: outputs.serviceName })
        .pipe(
          Effect.map(() => "present" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.orDie,
          Effect.provide(GcpHttp),
        );
      expect(service).toBe("gone");
    }),
    { timeout: 900_000 },
  );

  const baseUrlOf = (url: string | undefined) => {
    if (url === undefined) throw new Error("the service has no URL");
    return url.replace(/\/+$/, "");
  };

  /**
   * Wait until the service answers *and* can reach Redis: `/count` hits
   * the instance over the VPC, and answers 500 until the path is up.
   */
  const ready = (baseUrl: string) =>
    HttpClient.execute(HttpClientRequest.get(`${baseUrl}/count/warmup`)).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (response) => response.status === 200,
        times: 36,
      }),
    );

  const hit = (baseUrl: string, key: string) =>
    HttpClient.execute(HttpClientRequest.post(`${baseUrl}/hit/${key}`));

  const count = (baseUrl: string, key: string) =>
    HttpClient.execute(HttpClientRequest.get(`${baseUrl}/count/${key}`)).pipe(
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as unknown as Counter),
    );

  test(
    "provisions a BASIC 1 GiB instance with AUTH on a private IP",
    Effect.gen(function* () {
      const { instanceName, redisHost } = yield* stack;
      const instance = yield* redis
        .getProjectsLocationsInstances({ name: instanceName })
        .pipe(Effect.orDie, Effect.provide(GcpHttp));
      expect(instance.state).toBe("READY");
      expect(instance.tier).toBe("BASIC");
      expect(instance.memorySizeGb).toBe(1);
      expect(instance.authEnabled).toBe(true);
      expect(instance.host).toEqual(redisHost);
      // Memorystore only has a private address.
      expect(redisHost).toMatch(/^(10|172|192)\./);
    }),
    { timeout: 60_000 },
  );

  test(
    "counts hits, sets the window TTL, and enforces the limit",
    Effect.gen(function* () {
      const { url } = yield* stack;
      expect(url).toMatch(/^https:\/\//);
      const baseUrl = baseUrlOf(url);
      const warm = yield* ready(baseUrl);
      expect(warm.status).toBe(200);

      const key = `integ-${crypto.randomUUID()}`;

      const fresh = yield* count(baseUrl, key);
      expect(fresh).toMatchObject({ key, count: 0, resetInSeconds: null });

      for (let n = 1; n <= LIMIT; n++) {
        const response = yield* hit(baseUrl, key);
        expect(response.status).toBe(200);
        const body = (yield* response.json) as unknown as Counter;
        expect(body).toMatchObject({
          key,
          count: n,
          limit: LIMIT,
          remaining: LIMIT - n,
          limited: false,
        });
        expect(body.resetInSeconds).toBeGreaterThan(0);
        expect(body.resetInSeconds).toBeLessThanOrEqual(WINDOW_SECONDS);
      }

      const over = yield* hit(baseUrl, key);
      expect(over.status).toBe(429);
      expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
      expect((yield* over.json) as unknown as Counter).toMatchObject({
        count: LIMIT + 1,
        remaining: 0,
        limited: true,
      });

      // The window's TTL is set once, on the first hit, and ticks down.
      const after = yield* count(baseUrl, key);
      expect(after.count).toBe(LIMIT + 1);
      expect(after.resetInSeconds).toBeGreaterThan(0);
      expect(after.resetInSeconds).toBeLessThanOrEqual(WINDOW_SECONDS);

      // Keys count independently.
      const other = yield* hit(baseUrl, `${key}-other`);
      expect(other.status).toBe(200);
      expect(((yield* other.json) as unknown as Counter).count).toBe(1);
    }),
    { timeout: 300_000 },
  );

  test(
    "rejects malformed keys and unknown routes",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const baseUrl = baseUrlOf(url);
      yield* ready(baseUrl);

      const bad = yield* hit(baseUrl, "no%20spaces");
      expect(bad.status).toBe(404);
      const unknown = yield* HttpClient.execute(
        HttpClientRequest.get(`${baseUrl}/hit/abc`),
      );
      expect(unknown.status).toBe(404);
    }),
    { timeout: 300_000 },
  );
});
