import * as Docker from "@/Docker";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import TestService, { SERVICE_EXTERNAL_PORT } from "./fixtures/service.ts";
import { ensureDockerSwarm } from "./Runtime.ts";

const { test } = Test.make({ providers: Docker.providers() });

// Full end-to-end for the effectful `Docker.Service` platform: bundle the
// fixture's Effect program, build the content-addressed image on the local
// engine, deploy it as a swarm service, and prove over HTTP that (a) the
// `{ fetch }` handler is served and (b) the `ServerHost.run` background loop
// is actually executing inside the swarm task (`/ticks` keeps climbing).
test.provider(
  "effectful service serves fetch and runs background loops",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureDockerSwarm;
      yield* stack.destroy();

      const service = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TestService;
        }),
      );

      expect(service.id.length).toBeGreaterThan(0);
      expect(service.replicas).toBe(1);
      // The bundled image is content-addressed: <physical-name>:<hash>.
      expect(service.code?.hash).toBeTruthy();
      expect(service.image).toContain(service.code!.hash);
      expect(service.ports).toEqual([
        {
          external: SERVICE_EXTERNAL_PORT,
          internal: 3000,
          protocol: "tcp",
          mode: "ingress",
        },
      ]);

      // The swarm ingress publishes the fixed external port on the local
      // node. Retry through task startup (image already local, so this is
      // just container boot + routing-mesh programming).
      const base = `http://localhost:${SERVICE_EXTERNAL_PORT}`;
      const health = yield* HttpClient.get(`${base}/health`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`/health returned ${res.status}`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
      );
      expect(yield* health.json).toEqual({ ok: true });

      // Prove the ServerHost.run background loop is executing in-container:
      // the tick counter climbs between two reads.
      const readTicks = HttpClient.get(`${base}/ticks`).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((body) => (body as { ticks: number }).ticks),
      );
      const first = yield* readTicks;
      const second = yield* readTicks.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (ticks) => ticks > first,
          times: 10,
        }),
      );
      expect(second).toBeGreaterThan(first);

      // Redeploy with unchanged code: the diff is a noop (no replacement,
      // same service id, same content hash).
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TestService;
        }),
      );
      expect(redeployed.id).toBe(service.id);
      expect(redeployed.code?.hash).toBe(service.code?.hash);

      const imageRef = service.image;
      yield* stack.destroy();

      // The swarm service is gone after destroy.
      const docker = yield* Docker.Docker;
      const gone = yield* docker.service.inspect(service.id).pipe(
        Effect.map(() => false),
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed(true),
        ),
      );
      expect(gone).toBe(true);

      // The content-addressed image built for the bundled program was
      // cleaned up with the service.
      const imageGone = yield* docker.image.inspect(imageRef).pipe(
        Effect.map(() => false),
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed(true),
        ),
      );
      expect(imageGone).toBe(true);
    }),
  { timeout: 420_000 },
);
