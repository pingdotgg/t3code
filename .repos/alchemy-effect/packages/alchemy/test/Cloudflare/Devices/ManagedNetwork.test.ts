import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
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
const getNetwork = (accountId: string, networkId: string) =>
  zeroTrust.getDeviceNetwork({ accountId, networkId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, networkId: string) =>
  getNetwork(accountId, networkId).pipe(
    Effect.flatMap((n) =>
      // The managed-networks GET returns a nullable result rather than a
      // 404 once the network is deleted — treat both shapes as gone.
      n.networkId == null
        ? Effect.void
        : Effect.fail({ _tag: "NetworkNotDeleted" } as const),
    ),
    Effect.catchTag("DeviceNetworkNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "NetworkNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

const SHA_A =
  "b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c" as const;
const SHA_B =
  "7d865e959b2466918c9863afca942d0fb89d7c9ac0c99bafc3749504ded97730" as const;

test.provider(
  "create, update in place, and delete a managed network",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const network = yield* stack.deploy(
        Cloudflare.Devices.DeviceManagedNetwork("Office", {
          name: "alchemy-test-managed-network",
          config: { tlsSockaddr: "192.0.2.1:443", sha256: SHA_A },
        }),
      );

      expect(network.networkId).toBeTruthy();
      expect(network.accountId).toEqual(accountId);
      expect(network.name).toEqual("alchemy-test-managed-network");
      expect(network.type).toEqual("tls");
      expect(network.config.tlsSockaddr).toEqual("192.0.2.1:443");
      expect(network.config.sha256).toEqual(SHA_A);

      // Out-of-band verify against the live API.
      const live = yield* getNetwork(accountId, network.networkId);
      expect(live.name).toEqual("alchemy-test-managed-network");
      expect(live.config?.tlsSockaddr).toEqual("192.0.2.1:443");

      // Update config in place — same networkId.
      const updated = yield* stack.deploy(
        Cloudflare.Devices.DeviceManagedNetwork("Office", {
          name: "alchemy-test-managed-network",
          config: { tlsSockaddr: "192.0.2.2:443", sha256: SHA_B },
        }),
      );
      expect(updated.networkId).toEqual(network.networkId);
      expect(updated.config.tlsSockaddr).toEqual("192.0.2.2:443");
      expect(updated.config.sha256).toEqual(SHA_B);

      const live2 = yield* getNetwork(accountId, network.networkId);
      expect(live2.config?.tlsSockaddr).toEqual("192.0.2.2:443");

      // Redeploying identical props is a no-op (same network).
      const noop = yield* stack.deploy(
        Cloudflare.Devices.DeviceManagedNetwork("Office", {
          name: "alchemy-test-managed-network",
          config: { tlsSockaddr: "192.0.2.2:443", sha256: SHA_B },
        }),
      );
      expect(noop.networkId).toEqual(network.networkId);

      yield* stack.destroy();
      yield* expectGone(accountId, network.networkId);
    }).pipe(logLevel),
);

test.provider("list enumerates the deployed managed network", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Cloudflare.Devices.DeviceManagedNetwork("ListResource", {
        name: "alchemy-test-managed-network-list",
        config: { tlsSockaddr: "192.0.2.3:443", sha256: SHA_A },
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Devices.DeviceManagedNetwork,
    );
    const all = yield* provider.list();

    expect(all.some((n) => n.networkId === deployed.networkId)).toBe(true);

    yield* stack.destroy();
    yield* expectGone(deployed.accountId, deployed.networkId);
  }).pipe(logLevel),
);
