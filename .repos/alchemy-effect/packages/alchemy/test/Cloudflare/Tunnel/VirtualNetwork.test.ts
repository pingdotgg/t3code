import { adopt } from "@/AdoptPolicy";
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
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band verification calls.
const getVnet = (accountId: string, virtualNetworkId: string) =>
  zeroTrust.getNetworkVirtualNetwork({ accountId, virtualNetworkId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A destroyed virtual network either 404s (`VirtualNetworkNotFound`, code
// 1046) or is soft-deleted with `deletedAt` set.
const expectGone = (accountId: string, virtualNetworkId: string) =>
  getVnet(accountId, virtualNetworkId).pipe(
    Effect.flatMap((vnet) =>
      vnet.deletedAt
        ? Effect.void
        : Effect.fail({ _tag: "VnetNotDeleted" } as const),
    ),
    Effect.catchTag("VirtualNetworkNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "VnetNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider("create, verify, and destroy a virtual network", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const vnet = yield* stack.deploy(
      Cloudflare.Tunnel.VirtualNetwork("BasicVnet", {
        name: "alchemy-zt-vnet-basic",
        comment: "alchemy test vnet",
      }).pipe(adopt(true)),
    );

    expect(vnet.virtualNetworkId).toBeTruthy();
    expect(vnet.accountId).toEqual(accountId);
    expect(vnet.name).toEqual("alchemy-zt-vnet-basic");
    expect(vnet.comment).toEqual("alchemy test vnet");
    expect(vnet.isDefaultNetwork).toBe(false);

    const live = yield* getVnet(accountId, vnet.virtualNetworkId);
    expect(live.name).toEqual("alchemy-zt-vnet-basic");
    expect(live.comment).toEqual("alchemy test vnet");

    yield* stack.destroy();
    yield* expectGone(accountId, vnet.virtualNetworkId);
  }).pipe(logLevel),
);

test.provider("update name and comment in place (same id)", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.Tunnel.VirtualNetwork("UpdateVnet", {
        name: "alchemy-zt-vnet-update",
        comment: "v1",
      }).pipe(adopt(true)),
    );

    const updated = yield* stack.deploy(
      Cloudflare.Tunnel.VirtualNetwork("UpdateVnet", {
        name: "alchemy-zt-vnet-update-v2",
        comment: "v2",
      }).pipe(adopt(true)),
    );

    // Same vnet mutated in place — not a replacement.
    expect(updated.virtualNetworkId).toEqual(initial.virtualNetworkId);
    expect(updated.name).toEqual("alchemy-zt-vnet-update-v2");
    expect(updated.comment).toEqual("v2");

    const live = yield* getVnet(accountId, updated.virtualNetworkId);
    expect(live.name).toEqual("alchemy-zt-vnet-update-v2");
    expect(live.comment).toEqual("v2");

    // Redeploying identical props is a no-op.
    const noop = yield* stack.deploy(
      Cloudflare.Tunnel.VirtualNetwork("UpdateVnet", {
        name: "alchemy-zt-vnet-update-v2",
        comment: "v2",
      }).pipe(adopt(true)),
    );
    expect(noop.virtualNetworkId).toEqual(initial.virtualNetworkId);

    yield* stack.destroy();
    yield* expectGone(accountId, initial.virtualNetworkId);
  }).pipe(logLevel),
);

test.provider("recreates after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const vnet = yield* stack.deploy(
      Cloudflare.Tunnel.VirtualNetwork("HealVnet", {
        name: "alchemy-zt-vnet-heal",
        comment: "v1",
      }).pipe(adopt(true)),
    );

    yield* zeroTrust
      .deleteNetworkVirtualNetwork({
        accountId,
        virtualNetworkId: vnet.virtualNetworkId,
      })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );

    // Change a prop to force reconcile — it must observe the vnet as
    // missing and recreate it instead of failing on a 404.
    const healed = yield* stack.deploy(
      Cloudflare.Tunnel.VirtualNetwork("HealVnet", {
        name: "alchemy-zt-vnet-heal",
        comment: "v2",
      }).pipe(adopt(true)),
    );

    expect(healed.virtualNetworkId).not.toEqual(vnet.virtualNetworkId);
    expect(healed.comment).toEqual("v2");
    const live = yield* getVnet(accountId, healed.virtualNetworkId);
    expect(live.comment).toEqual("v2");

    yield* stack.destroy();
    yield* expectGone(accountId, healed.virtualNetworkId);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed virtual network", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Cloudflare.Tunnel.VirtualNetwork("ListVnet", {
        name: "alchemy-zt-vnet-list",
        comment: "alchemy list test vnet",
      }).pipe(adopt(true)),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Tunnel.VirtualNetwork,
    );
    const all = yield* provider.list();

    expect(
      all.some((v) => v.virtualNetworkId === deployed.virtualNetworkId),
    ).toBe(true);
    const found = all.find(
      (v) => v.virtualNetworkId === deployed.virtualNetworkId,
    );
    expect(found?.name).toEqual("alchemy-zt-vnet-list");

    yield* stack.destroy();
    yield* expectGone(deployed.accountId, deployed.virtualNetworkId);
  }).pipe(logLevel),
);
