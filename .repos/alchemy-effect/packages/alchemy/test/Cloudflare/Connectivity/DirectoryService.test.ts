import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as connectivity from "@distilled.cloud/cloudflare/connectivity";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getService = (accountId: string, serviceId: string) =>
  connectivity.getDirectoryService({ accountId, serviceId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

class ServiceStillExists extends Data.TaggedError("ServiceStillExists") {}

const expectGone = (accountId: string, serviceId: string) =>
  getService(accountId, serviceId).pipe(
    Effect.flatMap(() => Effect.fail(new ServiceStillExists())),
    // A missing service surfaces as the typed `VpcServiceNotFound`
    // (Cloudflare error code 5104) — that's the success condition here.
    Effect.catchTag("VpcServiceNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ServiceStillExists",
      schedule: Schedule.exponential("500 millis"),
      times: 10,
    }),
  );

test.provider("tcp service lifecycle: create, update, host switch", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    // Create — tcp database service on a tunnel-backed IPv4 host.
    const { tunnel, service } = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("DirSvcTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        const service = yield* Cloudflare.Connectivity.DirectoryService(
          "PgService",
          {
            name: "alchemy-connectivity-dirsvc-tcp",
            type: "tcp",
            tcpPort: 5432,
            appProtocol: "postgresql",
            host: {
              ipv4: "10.10.0.21",
              network: { tunnelId: tunnel.tunnelId },
            },
          },
        );
        return { tunnel, service };
      }),
    );

    expect(service.serviceId).toBeDefined();
    expect(service.accountId).toEqual(accountId);
    expect(service.name).toEqual("alchemy-connectivity-dirsvc-tcp");
    expect(service.type).toEqual("tcp");
    expect(service.tcpPort).toEqual(5432);
    expect(service.appProtocol).toEqual("postgresql");
    expect(service.host).toMatchObject({
      ipv4: "10.10.0.21",
      network: { tunnelId: tunnel.tunnelId },
    });

    // Out-of-band verify against the live API.
    const live = yield* getService(accountId, service.serviceId);
    expect(live.serviceId).toEqual(service.serviceId);
    expect(live.name).toEqual("alchemy-connectivity-dirsvc-tcp");

    // Update in place — new name and port, same serviceId.
    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("DirSvcTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.Connectivity.DirectoryService("PgService", {
          name: "alchemy-connectivity-dirsvc-tcp-v2",
          type: "tcp",
          tcpPort: 5433,
          appProtocol: "postgresql",
          host: {
            ipv4: "10.10.0.21",
            network: { tunnelId: tunnel.tunnelId },
          },
        });
      }),
    );

    expect(updated.serviceId).toEqual(service.serviceId);
    expect(updated.name).toEqual("alchemy-connectivity-dirsvc-tcp-v2");
    expect(updated.tcpPort).toEqual(5433);

    const liveUpdated = yield* getService(accountId, service.serviceId);
    expect(liveUpdated.name).toEqual("alchemy-connectivity-dirsvc-tcp-v2");

    // Switch the host variant (ipv4 -> hostname) — still an in-place
    // update, same serviceId. Keep the tunnel deployed across steps.
    const rehosted = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("DirSvcTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.Connectivity.DirectoryService("PgService", {
          name: "alchemy-connectivity-dirsvc-tcp-v2",
          type: "tcp",
          tcpPort: 5433,
          appProtocol: "postgresql",
          host: {
            hostname: "db.internal",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
        });
      }),
    );

    expect(rehosted.serviceId).toEqual(service.serviceId);
    expect(rehosted.host).toMatchObject({
      hostname: "db.internal",
      resolverNetwork: { tunnelId: tunnel.tunnelId },
    });

    // Redeploying identical props is a no-op (same serviceId, no drift).
    const noop = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("DirSvcTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.Connectivity.DirectoryService("PgService", {
          name: "alchemy-connectivity-dirsvc-tcp-v2",
          type: "tcp",
          tcpPort: 5433,
          appProtocol: "postgresql",
          host: {
            hostname: "db.internal",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
        });
      }),
    );
    expect(noop.serviceId).toEqual(service.serviceId);

    yield* stack.destroy();
    yield* expectGone(accountId, service.serviceId);

    // Destroy is idempotent — a second destroy of an empty stack is a no-op.
    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("http service with explicit ports and default name", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("DirSvcHttpTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.Connectivity.DirectoryService("HttpService", {
          type: "http",
          httpPort: 8080,
          httpsPort: 8443,
          host: {
            hostname: "api.internal",
            resolverNetwork: {
              tunnelId: tunnel.tunnelId,
              resolverIps: ["10.0.0.53"],
            },
          },
        });
      }),
    );

    expect(service.serviceId).toBeDefined();
    // Name was omitted — the provider generates one from app/stage/id.
    expect(service.name).toBeTruthy();
    expect(service.type).toEqual("http");
    expect(service.httpPort).toEqual(8080);
    expect(service.httpsPort).toEqual(8443);
    expect(service.host).toMatchObject({
      hostname: "api.internal",
      resolverNetwork: { resolverIps: ["10.0.0.53"] },
    });

    const live = yield* getService(accountId, service.serviceId);
    expect(live.serviceId).toEqual(service.serviceId);

    // Update ports in place.
    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("DirSvcHttpTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.Connectivity.DirectoryService("HttpService", {
          type: "http",
          httpPort: 3000,
          httpsPort: 3001,
          host: {
            hostname: "api.internal",
            resolverNetwork: {
              tunnelId: tunnel.tunnelId,
              resolverIps: ["10.0.0.53"],
            },
          },
        });
      }),
    );

    expect(updated.serviceId).toEqual(service.serviceId);
    expect(updated.httpPort).toEqual(3000);
    expect(updated.httpsPort).toEqual(3001);

    yield* stack.destroy();
    yield* expectGone(accountId, service.serviceId);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed directory service", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("DirSvcListTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.Connectivity.DirectoryService("ListService", {
          name: "alchemy-connectivity-dirsvc-list",
          type: "tcp",
          tcpPort: 5432,
          host: {
            ipv4: "10.20.0.21",
            network: { tunnelId: tunnel.tunnelId },
          },
        });
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Connectivity.DirectoryService,
    );
    const all = yield* provider.list();

    expect(all.some((s) => s.serviceId === service.serviceId)).toBe(true);
    const found = all.find((s) => s.serviceId === service.serviceId)!;
    expect(found.name).toEqual("alchemy-connectivity-dirsvc-list");
    expect(found.type).toEqual("tcp");

    yield* stack.destroy();
    yield* expectGone(service.accountId, service.serviceId);
  }).pipe(logLevel),
);

test.provider("recreates after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const service = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("DirSvcHealTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.Connectivity.DirectoryService("HealService", {
          name: "alchemy-connectivity-dirsvc-heal",
          type: "http",
          httpPort: 8080,
          host: {
            hostname: "heal.internal",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
        });
      }),
    );

    // Delete the service out-of-band; a redeploy with changed props must
    // observe it as missing and recreate instead of failing on a 404.
    yield* connectivity
      .deleteDirectoryService({ accountId, serviceId: service.serviceId })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );

    const healed = yield* stack.deploy(
      Effect.gen(function* () {
        const tunnel = yield* Cloudflare.Tunnel.Tunnel("DirSvcHealTunnel", {
          ingress: [{ service: "http://localhost:8080" }],
          adopt: true,
        });
        return yield* Cloudflare.Connectivity.DirectoryService("HealService", {
          name: "alchemy-connectivity-dirsvc-heal",
          type: "http",
          httpPort: 9090,
          host: {
            hostname: "heal.internal",
            resolverNetwork: { tunnelId: tunnel.tunnelId },
          },
        });
      }),
    );

    expect(healed.serviceId).not.toEqual(service.serviceId);
    expect(healed.httpPort).toEqual(9090);
    const live = yield* getService(accountId, healed.serviceId);
    expect(live.name).toEqual("alchemy-connectivity-dirsvc-heal");

    yield* stack.destroy();
    yield* expectGone(accountId, healed.serviceId);
  }).pipe(logLevel),
);
