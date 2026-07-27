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

// Ride out 403 blips (`Forbidden`) while the harness-minted token
// propagates across Cloudflare's edge.
const getLocation = (accountId: string, locationId: string) =>
  zeroTrust.getGatewayLocation({ accountId, locationId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A deleted location surfaces as `GatewayLocationNotFound` (code 1103).
const expectGone = (accountId: string, locationId: string) =>
  getLocation(accountId, locationId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "LocationNotDeleted" } as const)),
    Effect.catchTag("GatewayLocationNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "LocationNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider("create, verify, and destroy a location", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const location = yield* stack.deploy(
      Cloudflare.Gateway.Location("BasicLocation", {
        name: "alchemy-zt-location-basic",
        ecsSupport: false,
      }),
    );

    expect(location.locationId).toBeTruthy();
    expect(location.accountId).toEqual(accountId);
    expect(location.name).toEqual("alchemy-zt-location-basic");
    expect(location.clientDefault).toBe(false);
    // Cloudflare assigns a stable DoH subdomain to every location.
    expect(location.dohSubdomain).toBeTruthy();

    const live = yield* getLocation(accountId, location.locationId);
    expect(live.name).toEqual("alchemy-zt-location-basic");
    expect(live.dohSubdomain).toEqual(location.dohSubdomain);

    yield* stack.destroy();
    yield* expectGone(accountId, location.locationId);
  }).pipe(logLevel),
);

test.provider("update name and ecsSupport in place (same id)", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.Gateway.Location("UpdateLocation", {
        name: "alchemy-zt-location-update",
        ecsSupport: false,
      }),
    );
    expect(initial.ecsSupport).toBe(false);

    const updated = yield* stack.deploy(
      Cloudflare.Gateway.Location("UpdateLocation", {
        name: "alchemy-zt-location-update-v2",
        ecsSupport: true,
      }),
    );

    // Same location mutated in place — not a replacement; the
    // server-assigned DoH subdomain is stable across updates.
    expect(updated.locationId).toEqual(initial.locationId);
    expect(updated.dohSubdomain).toEqual(initial.dohSubdomain);
    expect(updated.name).toEqual("alchemy-zt-location-update-v2");
    expect(updated.ecsSupport).toBe(true);

    const live = yield* getLocation(accountId, updated.locationId);
    expect(live.name).toEqual("alchemy-zt-location-update-v2");
    expect(live.ecsSupport).toBe(true);

    // Redeploying identical props is a no-op (still the same location).
    const noop = yield* stack.deploy(
      Cloudflare.Gateway.Location("UpdateLocation", {
        name: "alchemy-zt-location-update-v2",
        ecsSupport: true,
      }),
    );
    expect(noop.locationId).toEqual(initial.locationId);

    yield* stack.destroy();
    yield* expectGone(accountId, initial.locationId);
  }).pipe(logLevel),
);

test.provider("recreates after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const location = yield* stack.deploy(
      Cloudflare.Gateway.Location("HealLocation", {
        name: "alchemy-zt-location-heal",
        ecsSupport: false,
      }),
    );

    yield* zeroTrust
      .deleteGatewayLocation({ accountId, locationId: location.locationId })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );

    // Change a prop to force reconcile — it must observe the location as
    // missing and recreate it instead of failing on a 404.
    const healed = yield* stack.deploy(
      Cloudflare.Gateway.Location("HealLocation", {
        name: "alchemy-zt-location-heal",
        ecsSupport: true,
      }),
    );

    expect(healed.locationId).not.toEqual(location.locationId);
    expect(healed.ecsSupport).toBe(true);
    const live = yield* getLocation(accountId, healed.locationId);
    expect(live.ecsSupport).toBe(true);

    yield* stack.destroy();
    yield* expectGone(accountId, healed.locationId);
  }).pipe(logLevel),
);

// Canonical `list()` test (account-scoped collection): deploy a location,
// then enumerate every Gateway location in the account via the typed
// provider and assert the deployed one is present in the exhaustively
// paginated result.
test.provider("list enumerates deployed gateway locations", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const location = yield* stack.deploy(
      Cloudflare.Gateway.Location("ListLocation", {
        name: "alchemy-zt-location-list",
        ecsSupport: false,
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Gateway.Location);
    const all = yield* provider.list();

    // The deployed location appears with the exact `read` Attributes shape.
    const found = all.find((l) => l.locationId === location.locationId);
    expect(found).toBeDefined();
    expect(found?.name).toEqual("alchemy-zt-location-list");
    expect(found?.accountId).toEqual(location.accountId);

    yield* stack.destroy();
    yield* expectGone(location.accountId, location.locationId);
  }).pipe(logLevel),
);
