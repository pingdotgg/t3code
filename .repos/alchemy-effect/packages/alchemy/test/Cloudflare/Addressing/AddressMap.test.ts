import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as addressing from "@distilled.cloud/cloudflare/addressing";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A freshly minted scoped token propagates eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const resolveAccountId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return accountId;
});

const getMap = (accountId: string, addressMapId: string) =>
  addressing.getAddressMap({ accountId, addressMapId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
    Effect.catchTag("AddressMapNotFound", () => Effect.succeed(undefined)),
  );

// Address Maps require the BYOIP add-on or Cloudflare-assigned static IPs
// (Enterprise). On the standard testing account every mutating call fails
// with the typed `FeatureNotEnabled` error
// (`address_maps_not_enabled_on_account`). The test probes once: unentitled
// accounts assert the typed tag; entitled accounts run the full lifecycle.
test.provider(
  "address map lifecycle (typed FeatureNotEnabled on unentitled accounts)",
  (stack) =>
    Effect.gen(function* () {
      const accountId = yield* resolveAccountId;

      yield* stack.destroy();

      const probe = yield* addressing
        .createAddressMap({
          accountId,
          description: "alchemy-addressmap-probe",
          enabled: false,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.result,
        );

      if (Result.isFailure(probe)) {
        // Unentitled — the distilled call must fail with the typed
        // entitlement tag, never an untyped catch-all.
        expect(probe.failure._tag).toEqual("FeatureNotEnabled");
        yield* stack.destroy();
        return;
      }

      // Entitled — clean up the probe map and run the full lifecycle.
      if (probe.success.id) {
        yield* addressing
          .deleteAddressMap({ accountId, addressMapId: probe.success.id })
          .pipe(Effect.catchTag("AddressMapNotFound", () => Effect.void));
      }

      // Create a disabled map with a description.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Addressing.AddressMap("Map", {
            description: "alchemy-addressmap v1",
            enabled: false,
          });
        }),
      );
      expect(created.addressMapId).toBeDefined();
      expect(created.accountId).toEqual(accountId);
      expect(created.description).toEqual("alchemy-addressmap v1");
      expect(created.enabled).toEqual(false);

      // Out-of-band verification via the distilled API.
      const live = yield* getMap(accountId, created.addressMapId);
      expect(live?.description).toEqual("alchemy-addressmap v1");

      // Update the description in place — same physical map.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Addressing.AddressMap("Map", {
            description: "alchemy-addressmap v2",
            enabled: false,
          });
        }),
      );
      expect(updated.addressMapId).toEqual(created.addressMapId);
      expect(updated.description).toEqual("alchemy-addressmap v2");

      const patched = yield* getMap(accountId, updated.addressMapId);
      expect(patched?.description).toEqual("alchemy-addressmap v2");

      // Destroy and verify the map is gone (typed not-found read).
      yield* stack.destroy();
      const gone = yield* getMap(accountId, created.addressMapId);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// `list()` enumerates every Address Map on the account (paginated) and
// hydrates each into the full `read` shape. Requires the same BYOIP /
// static-IP entitlement as the lifecycle: unentitled accounts can't create
// a map to observe, so we probe once and assert the typed `FeatureNotEnabled`
// tag (clean skip); entitled accounts run the full deploy + list assertion.
test.provider(
  "list enumerates the deployed address map",
  (stack) =>
    Effect.gen(function* () {
      const accountId = yield* resolveAccountId;

      yield* stack.destroy();

      const probe = yield* addressing
        .createAddressMap({
          accountId,
          description: "alchemy-addressmap-list-probe",
          enabled: false,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.result,
        );

      if (Result.isFailure(probe)) {
        // Unentitled — the distilled call must fail with the typed
        // entitlement tag, never an untyped catch-all.
        expect(probe.failure._tag).toEqual("FeatureNotEnabled");
        yield* stack.destroy();
        return;
      }

      // Entitled — clean up the probe map and run the full lifecycle.
      if (probe.success.id) {
        yield* addressing
          .deleteAddressMap({ accountId, addressMapId: probe.success.id })
          .pipe(Effect.catchTag("AddressMapNotFound", () => Effect.void));
      }

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Addressing.AddressMap("ListMap", {
            description: "alchemy-addressmap-list",
            enabled: false,
          });
        }),
      );
      expect(deployed.addressMapId).toBeDefined();

      const provider = yield* Provider.findProvider(
        Cloudflare.Addressing.AddressMap,
      );
      const all = yield* provider.list();

      // The deployed map appears in the exhaustively-paginated result, fully
      // hydrated into the `read` shape (ips/memberships present).
      const found = all.find((m) => m.addressMapId === deployed.addressMapId);
      expect(found).toBeDefined();
      expect(found?.accountId).toEqual(accountId);
      expect(found?.description).toEqual("alchemy-addressmap-list");
      expect(found?.ips).toBeDefined();
      expect(found?.memberships).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
