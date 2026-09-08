import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command. The
// VpcService/Tunnel providers are mode-agnostic (single implementation), so
// they deploy the REAL cloud resources even in dev — only the Worker is
// emulated locally, and its `vpc_service` binding proxies to the real
// service through the remote-binding bridge.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const cloudflaredBin = Bun.which("cloudflared");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

/**
 * The dev worker binds a real VPC service two ways — the managed resource
 * and a `lookup` data source — through the remote-binding bridge (there is
 * nothing to emulate locally; before this the binding was rejected as
 * unsupported in local mode). Pins that the worker boots with `vpc_service`
 * bindings and both surface as Fetchers, and that a fetch round-trips
 * through the bridge to the real service (no connector runs, so the service
 * answers with an error — reaching it at all is the assertion).
 */
test.provider(
  "dev worker binds a vpc service through the remote bridge",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const tunnelAndService = Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("LocalVpcTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService.VpcService("LocalVpcSvc", {
          httpPort: 8080,
          host: {
            hostname: "localhost",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      });

      const svc = yield* stack.deploy(tunnelAndService);
      // Mode-agnostic provider: a real cloud id even in dev, never `dev:`.
      expect(svc.serviceId).not.toMatch(/^dev:/);

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const managed = yield* tunnelAndService;
          const worker = yield* Cloudflare.Worker("vpc-local-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/vpc-local-worker.ts",
            ),
            env: {
              VPC: managed,
              VPC_LOOKUP: Cloudflare.VpcService.lookup({
                serviceId: svc.serviceId,
              }),
            },
          });
          return { worker };
        }),
      );

      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      // Both bindings surface as Fetchers inside the local workerd.
      for (const binding of ["VPC", "VPC_LOOKUP"]) {
        const body = (yield* getJsonReady(
          `${deployed.worker.url}/type?binding=${binding}`,
        )) as { type: string };
        expect(body.type).toBe("function");
      }

      // A fetch through the binding round-trips the remote bridge to the
      // real VPC service. Without a running connector the service cannot
      // reach an origin, so any JSON answer (an upstream error status or a
      // fetcher error) proves the bridge path; a broken bridge never
      // produces one.
      const proxied = (yield* getJsonReady(
        `${deployed.worker.url}/proxy?binding=VPC`,
      )) as { status?: number; error?: string };
      expect(proxied.status !== undefined || proxied.error !== undefined).toBe(
        true,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

const ORIGIN_PORT = 18787;

/**
 * Full end-to-end: a local HTTP origin, a real `cloudflared` connector for
 * the tunnel, and the dev worker fetching the origin through
 * `env.VPC.fetch()` — local workerd → remote bridge → real VPC service →
 * tunnel → connector on this machine → local origin. Gated on the
 * `cloudflared` binary being installed.
 */
test.provider.skipIf(!cloudflaredBin)(
  "dev worker fetches a local origin through a cloudflared connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const tunnelAndService = Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("E2eVpcTunnel", {
          ingress: [{ service: `http://localhost:${ORIGIN_PORT}` }],
          adopt: true,
        });
        const service = yield* Cloudflare.VpcService.VpcService("E2eVpcSvc", {
          httpPort: ORIGIN_PORT,
          host: {
            ipv4: "127.0.0.1",
            network: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
        return { tunnel, service };
      });

      const { tunnel } = yield* stack.deploy(tunnelAndService);

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const { service } = yield* tunnelAndService;
          const worker = yield* Cloudflare.Worker("vpc-e2e-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/vpc-local-worker.ts",
            ),
            env: { VPC: service },
          });
          return { worker };
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          // Local origin the tunnel connector will proxy to.
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                port: ORIGIN_PORT,
                fetch: (req) =>
                  new Response(`origin:${new URL(req.url).pathname}`),
              }),
            ),
            (server) => Effect.sync(() => void server.stop(true)),
          );

          // The connector for the tunnel, running on this machine.
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.spawn(
                [
                  cloudflaredBin!,
                  "tunnel",
                  "run",
                  "--token",
                  Redacted.value(tunnel.token),
                ],
                { stdout: "ignore", stderr: "ignore" },
              ),
            ),
            (proc) => Effect.sync(() => proc.kill()),
          );

          // Poll the worker until the fetch lands on the origin — the
          // connector takes a few seconds to register, and the service→edge
          // wiring can lag behind it.
          const body = yield* getJsonReady(
            `${deployed.worker.url}/proxy?binding=VPC&url=http://vpc/hello`,
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (b) => (b as { status?: number }).status === 200,
              times: 30,
            }),
          );

          expect(body).toEqual({ status: 200, body: "origin:/hello" });
        }),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
