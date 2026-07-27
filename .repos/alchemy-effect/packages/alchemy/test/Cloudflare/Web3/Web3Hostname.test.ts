import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as web3 from "@distilled.cloud/cloudflare/web3";
import * as zones from "@distilled.cloud/cloudflare/zones";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Cloudflare has restricted Web3 gateways for new customers — on the
// standard testing account every create fails with "Account is not entitled
// to create ipfs hostnames." (code 1010), surfaced as the typed
// `Web3HostnameNotEntitled` error. The full lifecycle tests below are gated
// behind an entitled zone id supplied via env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_WEB3_ZONE_ID;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// A freshly minted scoped token propagates eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const listHostnames = (zoneId: string) =>
  web3.listHostnames.items({ zoneId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const findHostname = (zoneId: string, name: string) =>
  listHostnames(zoneId).pipe(
    Effect.map((hostnames) =>
      hostnames.find((h) => h.name === name && h.status !== "deleting"),
    ),
  );

const getHostname = (zoneId: string, hostnameId: string) =>
  web3.getHostname({ zoneId, identifier: hostnameId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Purge leftovers from interrupted runs so tests start from a clean slate.
const purgeHostname = (zoneId: string, name: string) =>
  listHostnames(zoneId).pipe(
    Effect.flatMap(
      Effect.forEach((h) =>
        h.name === name && h.id
          ? web3
              .deleteHostname({ zoneId, identifier: h.id })
              .pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ),
    ),
  );

// Deletion is asynchronous — poll (bounded) until no live hostname with the
// given name remains in the zone.
const waitUntilGone = (zoneId: string, name: string) =>
  findHostname(zoneId, name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (h) => h === undefined,
      times: 10,
    }),
  );

test.provider(
  "surfaces the typed Web3HostnameNotEntitled error on unentitled accounts",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The testing account lacks the Web3 gateway entitlement — the
      // distilled call must fail with the typed entitlement tag.
      const error = yield* web3
        .createHostname({
          zoneId,
          name: `alchemy-web3-entitlement.${zoneName}`,
          target: "ipfs",
          dnslink: "/ipns/onboarding.ipfs.cloudflare.com",
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("Web3HostnameNotEntitled");

      // The list endpoint is available regardless of entitlement.
      const hostnames = yield* listHostnames(zoneId);
      expect(Array.isArray(hostnames)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!entitledZoneId)(
  "create, update in place, replace on target change, destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;
      const zone = yield* zones.getZone({ zoneId });
      const name = `alchemy-web3-hostname.${zone.name}`;

      yield* stack.destroy();
      yield* purgeHostname(zoneId, name);

      // Create an IPFS hostname pinned to a DNSLink.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Web3.Hostname("Gateway", {
            zoneId,
            name,
            target: "ipfs",
            dnslink: "/ipns/onboarding.ipfs.cloudflare.com",
            description: "v1",
          });
        }),
      );

      expect(created.hostnameId).toBeDefined();
      expect(created.zoneId).toEqual(zoneId);
      expect(created.name).toEqual(name);
      expect(created.target).toEqual("ipfs");
      expect(created.dnslink).toEqual("/ipns/onboarding.ipfs.cloudflare.com");
      expect(created.description).toEqual("v1");
      expect(["active", "pending"]).toContain(created.status);

      // Out-of-band verification via the distilled API.
      const live = yield* getHostname(zoneId, created.hostnameId);
      expect(live.name).toEqual(name);
      expect(live.target).toEqual("ipfs");

      // Update mutable fields in place — same physical hostname.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Web3.Hostname("Gateway", {
            zoneId,
            name,
            target: "ipfs",
            dnslink: "/ipns/onboarding.ipfs.cloudflare.com",
            description: "v2",
          });
        }),
      );
      expect(updated.hostnameId).toEqual(created.hostnameId);
      expect(updated.description).toEqual("v2");

      const patched = yield* getHostname(zoneId, updated.hostnameId);
      expect(patched.description).toEqual("v2");

      // Changing the target replaces the hostname.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Web3.Hostname("Gateway", {
            zoneId,
            name,
            target: "ethereum",
          });
        }),
      );
      expect(replaced.hostnameId).not.toEqual(created.hostnameId);
      expect(replaced.target).toEqual("ethereum");

      yield* stack.destroy();

      // Deletion is asynchronous — wait (bounded) until the hostname is
      // gone from the zone.
      const gone = yield* waitUntilGone(zoneId, name);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitledZoneId)(
  "content list — set entries, update declaratively, reset on destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;
      const zone = yield* zones.getZone({ zoneId });
      const name = `alchemy-web3-universal.${zone.name}`;
      const cid = "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco";

      yield* stack.destroy();
      yield* purgeHostname(zoneId, name);

      const program = (entries: Cloudflare.Web3.ContentListEntry[]) =>
        Effect.gen(function* () {
          const gateway = yield* Cloudflare.Web3.Hostname("Universal", {
            zoneId,
            name,
            target: "ipfs_universal_path",
          });
          const list = yield* Cloudflare.Web3.HostnameContentList("Blocklist", {
            zoneId,
            hostnameId: gateway.hostnameId,
            entries,
          });
          return { gateway, list };
        });

      // Create the universal-path gateway plus a one-entry blocklist.
      const created = yield* stack.deploy(
        program([{ type: "cid", content: cid, description: "blocked" }]),
      );
      expect(created.list.action).toEqual("block");
      expect(created.list.entries).toHaveLength(1);
      expect(created.list.entries[0]?.content).toEqual(cid);

      // Out-of-band verification via the distilled API.
      const liveEntries = yield* web3
        .listHostnameIpfsUniversalPathContentListEntries({
          zoneId,
          identifier: created.gateway.hostnameId,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );
      expect(liveEntries.entries ?? []).toHaveLength(1);
      expect(liveEntries.entries?.[0]?.content).toEqual(cid);

      // Declarative update — the bulk PUT replaces the whole list.
      const updated = yield* stack.deploy(
        program([{ type: "content_path", content: `/ipfs/${cid}/wiki` }]),
      );
      expect(updated.list.entries).toHaveLength(1);
      expect(updated.list.entries[0]?.type).toEqual("content_path");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(zoneId, name);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
