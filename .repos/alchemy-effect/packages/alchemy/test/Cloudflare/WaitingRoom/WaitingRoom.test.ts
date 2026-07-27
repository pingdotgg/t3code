import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as waitingRooms from "@distilled.cloud/cloudflare/waiting-rooms";
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

// Waiting Rooms require a Business or Enterprise zone plan. On the testing
// account's zone every write fails with "Zone not entitled to this
// functionality" (Cloudflare code 1034), surfaced as the typed
// `ZoneNotEntitled` error. The full lifecycle test below is gated behind an
// entitled zone id supplied via env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_WAITING_ROOM_ZONE_ID;
const entitledZoneHost =
  process.env.CLOUDFLARE_TEST_WAITING_ROOM_HOST ?? zoneName;

// Deterministic per-test room names — reused on every run.
const NAME_LIFECYCLE = "alchemy-waitingroom-lifecycle";

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

// Freshly minted scoped tokens propagate eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getRoom = (zoneId: string, waitingRoomId: string) =>
  waitingRooms.getWaitingRoom({ zoneId, waitingRoomId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const findRoomByName = (zoneId: string, name: string) =>
  waitingRooms.listWaitingRoomsForZone.items({ zoneId }).pipe(
    Stream.filter((room) => room.name === name),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)[0]),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "surfaces the typed ZoneNotEntitled error on unentitled zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The standard testing zone lacks the Waiting Rooms entitlement —
      // the distilled create must fail with the typed plan-gate tag.
      const error = yield* waitingRooms
        .createWaitingRoom({
          zoneId,
          name: "alchemy-waitingroom-entitlement-probe",
          host: zoneName,
          totalActiveUsers: 200,
          newUsersPerMinute: 200,
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("ZoneNotEntitled");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!entitledZoneId)(
  "create, update in place, and destroy a waiting room",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.WaitingRoom.WaitingRoom("Room", {
            zoneId,
            name: NAME_LIFECYCLE,
            host: entitledZoneHost,
            path: "/alchemy-test",
            totalActiveUsers: 200,
            newUsersPerMinute: 200,
            description: "v1",
          });
        }),
      );

      expect(initial.waitingRoomId).toBeDefined();
      expect(initial.zoneId).toEqual(zoneId);
      expect(initial.name).toEqual(NAME_LIFECYCLE);
      expect(initial.host).toEqual(entitledZoneHost);
      expect(initial.path).toEqual("/alchemy-test");
      expect(initial.totalActiveUsers).toEqual(200);
      expect(initial.newUsersPerMinute).toEqual(200);
      expect(initial.description).toEqual("v1");
      // Cloudflare defaults.
      expect(initial.sessionDuration).toEqual(5);
      expect(initial.queueAll).toEqual(false);
      expect(initial.queueingMethod).toEqual("fifo");
      expect(initial.suspended).toEqual(false);

      // Out-of-band verification via the distilled API.
      const live = yield* getRoom(zoneId, initial.waitingRoomId);
      expect(live.id).toEqual(initial.waitingRoomId);
      expect(live.name).toEqual(NAME_LIFECYCLE);
      expect(live.host).toEqual(entitledZoneHost);

      // Update mutable fields in place — same physical room.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.WaitingRoom.WaitingRoom("Room", {
            zoneId,
            name: NAME_LIFECYCLE,
            host: entitledZoneHost,
            path: "/alchemy-test",
            totalActiveUsers: 250,
            newUsersPerMinute: 200,
            description: "v2",
            sessionDuration: 10,
            queueAll: true,
          });
        }),
      );

      expect(updated.waitingRoomId).toEqual(initial.waitingRoomId);
      expect(updated.totalActiveUsers).toEqual(250);
      expect(updated.description).toEqual("v2");
      expect(updated.sessionDuration).toEqual(10);
      expect(updated.queueAll).toEqual(true);

      const liveUpdated = yield* getRoom(zoneId, updated.waitingRoomId);
      expect(liveUpdated.totalActiveUsers).toEqual(250);

      yield* stack.destroy();

      const gone = yield* findRoomByName(zoneId, NAME_LIFECYCLE);
      expect(gone).toBeUndefined();

      // Destroy again — deletion is idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (zone-scoped collection): waiting rooms have no
// account-wide enumeration API, so `list()` fans out across every zone via
// `listAllZones`, exhaustively paginates `listWaitingRoomsForZone` per zone,
// and hydrates each room into the `read` Attributes shape. Plan-gated /
// unentitled zones reject the route (typed `Forbidden`) and are skipped to
// `[]`. The standing test zone lacks the Waiting Rooms entitlement, so the
// read-only assertion only requires a well-typed array; the deployed-presence
// assertion is gated behind an entitled zone id supplied via env.
test.provider(
  "list enumerates waiting rooms across zones",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.WaitingRoom.WaitingRoom,
      );

      if (entitledZoneId) {
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.WaitingRoom.WaitingRoom("ListRoom", {
              zoneId: entitledZoneId,
              name: "alchemy-waitingroom-list",
              host: entitledZoneHost,
              path: "/alchemy-list",
              totalActiveUsers: 200,
              newUsersPerMinute: 200,
            });
          }),
        );

        const all = yield* provider.list();
        expect(
          all.some((r) => r.waitingRoomId === deployed.waitingRoomId),
        ).toBe(true);
      } else {
        // Unentitled standing zone: no rooms exist, but `list()` must still
        // return a well-typed array (unentitled zones skip to `[]`).
        const all = yield* provider.list();
        expect(Array.isArray(all)).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
