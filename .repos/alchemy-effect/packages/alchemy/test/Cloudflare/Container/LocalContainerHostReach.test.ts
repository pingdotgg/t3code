import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as NodeHttp from "node:http";
import {
  HOST_PROBE_PORT,
  NEON_URL,
  PLANETSCALE_MYSQL_URL,
  PLANETSCALE_PG_URL,
  PPG_URL,
} from "./fixtures/hostreach/object.ts";
import HostReachStack from "./fixtures/hostreach/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// First request has to wait for the local runtime to `docker build` the image
// and boot the container, so give it plenty of room.
const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 240_000;

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

/**
 * A host-side stand-in for a local dev database: an HTTP server bound to the
 * developer machine's loopback, exactly like `@prisma/dev`'s direct Postgres
 * endpoint. The container's env points at it via `http://localhost:<port>`.
 */
const hostServer = Effect.acquireRelease(
  Effect.callback<NodeHttp.Server>((resume) => {
    const server = NodeHttp.createServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("hello-from-host");
    });
    // Bind loopback only, like `@prisma/dev`. Docker Desktop's
    // host-gateway reaches 127.0.0.1. Native Linux cannot SYN the
    // bridge IP (UFW INPUT); the sidecar unix-socket-tunnels this
    // port into the container netns instead.
    server.listen(HOST_PROBE_PORT, "127.0.0.1", () =>
      resume(Effect.succeed(server)),
    );
    server.on("error", (err) => resume(Effect.die(err)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
);

/**
 * Regression test for alchemy-run/alchemy#1334: under `alchemy dev`, a
 * container's env values that reference the developer machine's loopback
 * (`localhost` / `127.0.0.1` — every local dev database emulator) must be
 * reachable from inside the Docker container, where `localhost` is the
 * container itself.
 */
describe("local container reaches host services", () => {
  const stack = beforeAll(deploy(HostReachStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(HostReachStack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    "container env loopback URLs are rewritten and reach the host",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      yield* hostServer;

      const get = (path: string) =>
        client.get(new URL(path, url)).pipe(
          Effect.flatMap((r) =>
            r.status !== 200
              ? Effect.fail(new Error(`not ready: ${r.status}`))
              : r.text,
          ),
          Effect.timeout("30 seconds"),
          Effect.retry({ schedule: readinessSchedule, times: 30 }),
        );

      // The env the container received: loopback hosts must be rewritten to
      // a name that resolves to the host machine — and that name must still
      // contain "localhost", because Prisma's client only speaks plain HTTP
      // to `prisma+postgres://` hosts that look local (anything else flips
      // it to TLS against a plain-HTTP local dev server).
      const env = JSON.parse(yield* get("/env")) as {
        TARGET_URL: string;
        PPG_URL: string;
        NEON_URL: string;
        PLANETSCALE_PG_URL: string;
        PLANETSCALE_MYSQL_URL: string;
      };
      expect(new URL(env.TARGET_URL).hostname).not.toBe("localhost");
      expect(new URL(env.TARGET_URL).hostname).toContain("localhost");
      expect(new URL(env.PPG_URL).hostname).not.toBe("localhost");
      expect(new URL(env.PPG_URL).hostname).toContain("localhost");
      // Everything else about the URLs is preserved.
      expect(new URL(env.TARGET_URL).port).toBe(String(HOST_PROBE_PORT));
      expect(new URL(env.PPG_URL).searchParams.get("api_key")).toBe(
        new URL(PPG_URL).searchParams.get("api_key"),
      );
      // Cloud SQL URLs (Neon, PlanetScale) must not be rewritten — they are
      // not loopback, and the container talks to them over the internet.
      expect(env.NEON_URL).toBe(NEON_URL);
      expect(env.PLANETSCALE_PG_URL).toBe(PLANETSCALE_PG_URL);
      expect(env.PLANETSCALE_MYSQL_URL).toBe(PLANETSCALE_MYSQL_URL);

      // The proof: the container fetches TARGET_URL (the host-side server)
      // and reports what it got back.
      const probe = JSON.parse(yield* get("/probe")) as {
        status?: number;
        body?: string;
        error?: string;
      };
      expect(probe.error).toBeUndefined();
      expect(probe.status).toBe(200);
      expect(probe.body).toBe("hello-from-host");
    }).pipe(Effect.scoped, logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
