import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as connectivity from "@distilled.cloud/cloudflare/connectivity";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create, update, delete vpc service", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const { tunnel, service } = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel("VpcTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        const service = yield* Cloudflare.VpcService("VpcSvc", {
          httpPort: 8080,
          host: {
            hostname: "localhost",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
        return { tunnel, service };
      }),
    );

    expect(service.serviceId).toBeDefined();
    expect(service.serviceType).toEqual("http");
    expect(service.httpPort).toEqual(8080);
    expect(service.host).toMatchObject({
      hostname: "localhost",
      resolverNetwork: { tunnelId: tunnel.tunnelId },
    });

    const fetched = yield* connectivity.getDirectoryService({
      accountId,
      serviceId: service.serviceId,
    });
    expect(fetched.serviceId).toEqual(service.serviceId);
    // @ts-expect-error
    expect(fetched.httpPort).toEqual(8080);

    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel("VpcTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService("VpcSvc", {
          httpPort: 3000,
          httpsPort: 3001,
          host: {
            hostname: "localhost",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      }),
    );

    expect(updated.serviceId).toEqual(service.serviceId);
    expect(updated.httpPort).toEqual(3000);
    expect(updated.httpsPort).toEqual(3001);

    const fetchedUpdated = yield* connectivity.getDirectoryService({
      accountId,
      serviceId: service.serviceId,
    });
    // @ts-expect-error
    expect(fetchedUpdated.httpPort).toEqual(3000);
    // @ts-expect-error
    expect(fetchedUpdated.httpsPort).toEqual(3001);

    yield* stack.destroy();

    yield* waitForServiceToBeDeleted(service.serviceId, accountId);
  }).pipe(logLevel),
);

test.provider("create vpc service with ipv4 host", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel("Ipv4Tunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService("Ipv4Svc", {
          httpPort: 8080,
          host: {
            ipv4: "192.168.1.100",
            network: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      }),
    );

    expect(service.host).toMatchObject({
      ipv4: "192.168.1.100",
    });
    expect("ipv6" in service.host).toBe(false);

    const fetched = yield* connectivity.getDirectoryService({
      accountId,
      serviceId: service.serviceId,
    });
    expect((fetched.host as { ipv4?: string }).ipv4).toEqual("192.168.1.100");

    yield* stack.destroy();
    yield* waitForServiceToBeDeleted(service.serviceId, accountId);
  }).pipe(logLevel),
);

// TODO: re-enable once distilled ships the union-ordering fix
// (alchemy-run/distilled#232) — on @distilled.cloud/cloudflare@0.16.3 the
// dual-stack host variant comes after the ipv4-only variant in the request
// schema's Schema.Union, so `ipv6` is silently stripped on encode.
test.provider.skip("create vpc service with dual-stack host", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel("DualStackTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.VpcService("DualStackSvc", {
          httpPort: 8080,
          host: {
            ipv4: "192.168.1.101",
            ipv6: "2001:db8::1",
            network: { tunnelId: tunnel.tunnelId },
          },
          adopt: true,
        });
      }),
    );

    expect(service.host).toMatchObject({
      ipv4: "192.168.1.101",
      ipv6: "2001:db8::1",
    });

    yield* stack.destroy();
    yield* waitForServiceToBeDeleted(service.serviceId, accountId);
  }).pipe(logLevel),
);

const waitForServiceToBeDeleted = Effect.fn(function* (
  serviceId: string,
  accountId: string,
) {
  yield* connectivity.getDirectoryService({ accountId, serviceId }).pipe(
    Effect.flatMap(() => Effect.fail(new VpcServiceStillExists())),
    Effect.retry({
      while: (e): e is VpcServiceStillExists =>
        e instanceof VpcServiceStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catch(() => Effect.void),
  );
});

class VpcServiceStillExists extends Data.TaggedError("VpcServiceStillExists") {}
