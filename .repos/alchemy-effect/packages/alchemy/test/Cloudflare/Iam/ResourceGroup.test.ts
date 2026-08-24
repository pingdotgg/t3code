import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as iam from "@distilled.cloud/cloudflare/iam";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic names — the same on every run (never Date.now()/random).
const RG_NAME = "alchemy-iam-rg-crud";
const RG_NAME_RENAMED = "alchemy-iam-rg-crud-renamed";

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union) on out-of-band verification calls.
const getResourceGroup = (accountId: string, resourceGroupId: string) =>
  iam.getResourceGroup({ accountId, resourceGroupId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// A destroyed resource group answers GET with the typed
// `ResourceGroupNotFound` (404).
const expectGone = (accountId: string, resourceGroupId: string) =>
  getResourceGroup(accountId, resourceGroupId).pipe(
    Effect.asSome,
    Effect.catchTag("ResourceGroupNotFound", () => Effect.succeedNone),
    Effect.repeat({
      schedule: Schedule.exponential("500 millis"),
      until: (g) => g._tag === "None",
      times: 8,
    }),
    Effect.map((g) => expect(g._tag).toEqual("None")),
  );

test.provider(
  "create, verify out-of-band, update name+scope in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const accountScopeKey = `com.cloudflare.api.account.${accountId}`;
      const zone = yield* findZoneByName({ accountId, name: zoneName });
      if (!zone) {
        return yield* Effect.die(
          new Error(`zone "${zoneName}" not found in account`),
        );
      }
      const zoneObjectKey = `com.cloudflare.api.account.zone.${zone.id}`;

      yield* stack.destroy();

      // Create — scoped to the whole account.
      const v1 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Iam.ResourceGroup("Rg", {
            name: RG_NAME,
            scope: {
              key: accountScopeKey,
              objects: [{ key: "*" }],
            },
          });
        }),
      );

      expect(v1.resourceGroupId).toBeTruthy();
      expect(v1.accountId).toEqual(accountId);
      expect(v1.name).toEqual(RG_NAME);
      expect(v1.scope.key).toEqual(accountScopeKey);
      expect(v1.scope.objects).toEqual([{ key: "*" }]);

      // Out-of-band verification via the distilled API.
      const live = yield* getResourceGroup(accountId, v1.resourceGroupId);
      expect(live.name).toEqual(RG_NAME);

      // In-place update — rename and narrow the scope to a single zone.
      // Same resource group (no replacement).
      const v2 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Iam.ResourceGroup("Rg", {
            name: RG_NAME_RENAMED,
            scope: {
              key: accountScopeKey,
              objects: [{ key: zoneObjectKey }],
            },
          });
        }),
      );

      expect(v2.resourceGroupId).toEqual(v1.resourceGroupId);
      expect(v2.name).toEqual(RG_NAME_RENAMED);
      expect(v2.scope.objects).toEqual([{ key: zoneObjectKey }]);

      const updated = yield* getResourceGroup(accountId, v2.resourceGroupId);
      expect(updated.name).toEqual(RG_NAME_RENAMED);

      // No-op deploy — same desired state, same identity, reconcile
      // observes the in-sync state and applies nothing.
      const v3 = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Iam.ResourceGroup("Rg", {
            name: RG_NAME_RENAMED,
            scope: {
              key: accountScopeKey,
              objects: [{ key: zoneObjectKey }],
            },
          });
        }),
      );
      expect(v3.resourceGroupId).toEqual(v1.resourceGroupId);

      yield* stack.destroy();

      yield* expectGone(accountId, v1.resourceGroupId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed resource group",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const accountScopeKey = `com.cloudflare.api.account.${accountId}`;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Iam.ResourceGroup("ListRg", {
            name: "alchemy-iam-rg-list",
            scope: {
              key: accountScopeKey,
              objects: [{ key: "*" }],
            },
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Iam.ResourceGroup,
      );
      const all = yield* provider.list();

      // Each element is the full `read` Attributes shape, usable by delete.
      expect(
        all.some((g) => g.resourceGroupId === deployed.resourceGroupId),
      ).toBe(true);

      yield* stack.destroy();

      yield* expectGone(accountId, deployed.resourceGroupId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
