import {
  EnvironmentId,
  type NetworkMember,
  type TailnetDevice,
  type TailnetDeviceAccess,
  type TailnetDeviceClientCredential,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { ConnectionBlockedError } from "./model.ts";
import {
  type NetworkMemberRecord,
  type NetworkRoster,
  type NetworkRosterReport,
  NetworkMembers,
  followNetworkRoster,
  followedNetwork,
  makeNetworkMemberRenewals,
  makeNetworkMembers,
  openNetworkMember,
  releaseNetworkMember,
} from "./networkMembers.ts";

const studio = EnvironmentId.make("env-studio");
const box = EnvironmentId.make("env-box");
const laptop = EnvironmentId.make("env-laptop");
const vps = EnvironmentId.make("env-vps");
const app = "app-phone";

const member = (environmentId: EnvironmentId, access: TailnetDeviceAccess): NetworkMember => ({
  environmentId,
  label: environmentId,
  nodeId: null,
  access,
  updatedAt: { wallMs: 1, counter: 0, node: environmentId },
});
const device = (
  environmentId: EnvironmentId,
  access: TailnetDeviceAccess = "full-access",
): TailnetDevice => ({
  environmentId,
  label: environmentId,
  nodeId: null,
  urls: [`https://${environmentId}.ts.net`],
  status: "online",
  access,
  member: member(environmentId, access),
  localLimit: null,
  outgoing: "tailnet",
  incoming: true,
  tailnetName: environmentId,
  lastSeenAt: null,
});
const report = (
  host: EnvironmentId,
  devices: ReadonlyArray<TailnetDevice>,
  overrides: Partial<NetworkRoster> = {},
): NetworkRosterReport => ({
  host,
  roster: {
    selfMember: member(host, "full-access"),
    devices,
    apps: [
      {
        appId: overrides.callerAppId ?? app,
        label: "Phone",
        access: "full-access",
        updatedAt: { wallMs: 1, counter: 0, node: host },
      },
    ],
    enabled: true,
    callerAppId: app,
    ...overrides,
  },
});
const record = (environmentId: EnvironmentId, via: EnvironmentId): NetworkMemberRecord => ({
  environmentId,
  label: environmentId,
  via,
  appId: app,
});
const credential = (environmentId: EnvironmentId): TailnetDeviceClientCredential => ({
  environmentId,
  urls: [`https://${environmentId}.ts.net`],
  credential: "one-time",
  expiresAt: DateTime.makeUnsafe(0),
});

/** An in-memory catalog: its member records and the environments saved in it. */
const makeCatalog = (initial: ReadonlyArray<NetworkMemberRecord> = []) =>
  Effect.gen(function* () {
    let stored = initial;
    const members = yield* makeNetworkMembers({
      read: Effect.sync(() => stored),
      write: (records) => Effect.sync(() => void (stored = records)),
    });
    const forgotten: Array<EnvironmentId> = [];
    const saved = new Set<EnvironmentId>();
    const follow = (reports: ReadonlyArray<NetworkRosterReport>, catalog = members) =>
      followNetworkRoster({
        reports,
        savedEnvironmentIds: Effect.sync(() => new Set(saved)),
        forget: (environmentId) => Effect.sync(() => void forgotten.push(environmentId)),
      }).pipe(Effect.provideService(NetworkMembers, catalog));
    return { members, forgotten, saved, follow, records: () => stored };
  });
const ids = (records: ReadonlyArray<NetworkMemberRecord>) =>
  records.map((candidate) => candidate.environmentId);

describe("makeNetworkMembers", () => {
  it.effect("loads on first use and never overwrites records it could not read", () =>
    Effect.gen(function* () {
      let stored: ReadonlyArray<NetworkMemberRecord> = [record(laptop, studio)];
      let reads = 0;
      const members = yield* makeNetworkMembers({
        read: Effect.suspend(() =>
          ++reads === 1
            ? Effect.fail(new ConnectionBlockedError({ reason: "configuration", detail: "locked" }))
            : Effect.succeed(stored),
        ),
        write: (records) => Effect.sync(() => void (stored = records)),
      });
      expect(reads).toBe(0);

      const add = members.update((current) => Effect.succeed([...current, record(vps, studio)]));
      expect(yield* Effect.flip(add)).toBeInstanceOf(ConnectionBlockedError);
      expect(ids(stored)).toEqual([laptop]);

      yield* add;
      expect(ids(stored)).toEqual([laptop, vps]);
      expect(reads).toBe(2);
    }),
  );
});

describe("followNetworkRoster", () => {
  it.effect("keeps members it lacks as records without opening any, and skips the user's own", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog();
      catalog.saved.add(studio).add(box);
      yield* catalog.follow([report(studio, [device(box), device(laptop)])]);

      expect(catalog.records()).toEqual([record(laptop, studio)]);

      // Revoking or dropping the user's own saved box never forgets it.
      yield* catalog.follow([report(studio, [device(box, "revoked")])]);
      yield* catalog.follow([report(studio, [])]);
      expect(catalog.forgotten).toEqual([]);
    }),
  );

  it.effect("drops a member any followed host reports revoked, even while another lists it", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([record(laptop, studio), record(vps, studio)]);
      catalog.saved.add(studio).add(box).add(laptop);

      yield* catalog.follow([
        report(studio, [device(laptop), device(vps)]),
        report(box, [device(laptop, "revoked"), device(vps)]),
      ]);
      expect(ids(catalog.records())).toEqual([vps]);
      expect(catalog.forgotten).toEqual([laptop]);
    }),
  );

  it.effect("drops a member only when no followed host lists it and its own host omits it", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([record(laptop, studio)]);
      catalog.saved.add(studio).add(box).add(laptop);

      // The studio switched the network off, then came back stale; the box still lists the laptop.
      yield* catalog.follow([
        report(studio, [], { enabled: false }),
        report(box, [device(laptop)]),
      ]);
      yield* catalog.follow([report(studio, []), report(box, [device(laptop)])]);
      expect(catalog.records()).toEqual([record(laptop, box)]);

      // The box is offline: the stale studio is not the laptop's host, and the laptop vouches for itself.
      yield* catalog.follow([report(studio, [])]);
      yield* catalog.follow([report(laptop, [])]);
      expect(catalog.records()).toEqual([record(laptop, box)]);
      expect(catalog.forgotten).toEqual([]);

      yield* catalog.follow([report(studio, []), report(box, [])]);
      expect(catalog.records()).toEqual([]);
      expect(catalog.forgotten).toEqual([laptop]);
    }),
  );

  it.effect("follows only hosts that are on, list this client's app, and share its app id", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([record(laptop, studio)]);
      catalog.saved.add(studio).add(box).add(vps).add(laptop);
      const other = report(vps, [device(laptop, "revoked"), device(box)], {
        callerAppId: "app-other",
      });
      const off = report(box, [device(laptop, "revoked")], { enabled: false });
      const pairing = report(box, [device(laptop, "revoked")], { callerAppId: null });
      const appRevoked = report(box, [device(laptop, "revoked")], {
        apps: [
          {
            appId: app,
            label: "Phone",
            access: "revoked",
            updatedAt: { wallMs: 1, counter: 0, node: box },
          },
        ],
      });

      expect(followedNetwork(catalog.records(), [other, off, pairing, appRevoked])).toEqual({
        appId: app,
        reports: [],
      });
      // A host revoking this app is a positive signal; see "old network revoke then new join".
      yield* catalog.follow([other, off, pairing]);
      expect(catalog.records()).toEqual([record(laptop, studio)]);
      expect(catalog.forgotten).toEqual([]);

      // With no records yet, the client follows one network (the smallest app id), not both.
      expect(followedNetwork([], [report(studio, []), other])).toEqual({
        appId: "app-other",
        reports: [other],
      });
    }),
  );

  it.effect("never takes over a member the user saves while the roster is followed", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog();
      catalog.saved.add(studio);
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const pairing = yield* releaseNetworkMember(
        laptop,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.andThen(Effect.sync(() => void catalog.saved.add(laptop))),
          Effect.as(true),
        ),
      ).pipe(Effect.provideService(NetworkMembers, catalog.members), Effect.forkChild);
      yield* Deferred.await(started);
      // The gate opens once the follow is waiting on the catalog, behind the pairing.
      const waiting = yield* Deferred.make<void>();
      const following = yield* catalog
        .follow([report(studio, [device(laptop)])], {
          ...catalog.members,
          update: (transform) =>
            Deferred.succeed(waiting, undefined).pipe(
              Effect.andThen(catalog.members.update(transform)),
            ),
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(waiting);
      yield* Deferred.succeed(gate, undefined);

      expect(yield* Fiber.join(pairing)).toBe(true);
      yield* Fiber.join(following);
      expect(catalog.records()).toEqual([]);
    }),
  );
});

describe("leaving a network", () => {
  const appNew = "app-new";
  const withApps = (
    host: EnvironmentId,
    devices: ReadonlyArray<TailnetDevice>,
    callerAppId: string,
    appAccess: TailnetDeviceAccess | null,
  ) =>
    report(host, devices, {
      callerAppId,
      apps:
        appAccess === null
          ? []
          : [
              {
                appId: callerAppId,
                label: "Phone",
                access: appAccess,
                updatedAt: { wallMs: 1, counter: 0, node: host },
              },
            ],
    });

  it.effect("old network revoke then new join", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([record(laptop, studio), record(vps, studio)]);
      // The box was paired by hand; it is no record, only a saved connection.
      catalog.saved.add(studio).add(laptop).add(box);
      const third = EnvironmentId.make("env-third");

      yield* catalog.follow([
        withApps(studio, [device(laptop), device(vps), device(box)], app, "revoked"),
        withApps(third, [device(box), device(laptop)], appNew, "full-access"),
      ]);

      expect(catalog.records()).toEqual([
        { environmentId: laptop, label: laptop, via: third, appId: appNew },
      ]);
      expect(
        followedNetwork(catalog.records(), [withApps(third, [], appNew, "full-access")]),
      ).toMatchObject({ appId: appNew });
      // Neither the hand-paired box nor the opened laptop's saved connection is forgotten.
      expect(catalog.forgotten).toEqual([]);
      expect([...catalog.saved]).toEqual([studio, laptop, box]);
    }),
  );

  it.effect("host leave", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([record(laptop, studio), record(vps, studio)]);
      catalog.saved.add(studio).add(box);
      // What the server reports after `leave`: no roster and no apps, the switch untouched.
      const left = withApps(studio, [], app, null);
      const afterLeave = { ...left, roster: { ...left.roster, selfMember: null } };

      // Offline, switched off, or itself revoked while still listing this app: nothing clears.
      yield* catalog.follow([]);
      yield* catalog.follow([{ ...afterLeave, roster: { ...afterLeave.roster, enabled: false } }]);
      yield* catalog.follow([report(studio, [], { selfMember: member(studio, "revoked") })]);
      expect(ids(catalog.records())).toEqual([laptop, vps]);

      yield* catalog.follow([afterLeave]);
      expect(catalog.records()).toEqual([]);
      expect(catalog.forgotten).toEqual([]);
      expect([...catalog.saved]).toEqual([studio, box]);
    }),
  );
});

describe("openNetworkMember", () => {
  it.effect("asks another followed host when the one that listed it is unreachable", () =>
    Effect.gen(function* () {
      const third = EnvironmentId.make("env-third");
      const catalog = yield* makeCatalog([record(laptop, studio), record(vps, studio)]);
      const minted: Array<readonly [EnvironmentId, EnvironmentId]> = [];
      const registered: Array<EnvironmentId> = [];
      const open = (hosts: ReadonlyArray<EnvironmentId>) =>
        openNetworkMember({
          environmentId: laptop,
          hosts,
          mint: (via, environmentId) =>
            Effect.sync(() => minted.push([via, environmentId])).pipe(
              Effect.andThen(
                via === box
                  ? Effect.fail(new ConnectionBlockedError({ reason: "permission", detail: "no" }))
                  : Effect.succeed(credential(environmentId)),
              ),
            ),
          register: (value) =>
            Effect.sync(() => registered.push(value.environmentId)).pipe(
              Effect.as(value.environmentId),
            ),
        }).pipe(Effect.provideService(NetworkMembers, catalog.members));

      // The studio is not followed: the box refuses, the third host mints.
      expect(yield* open([box, laptop, third])).toBe(laptop);
      expect(minted).toEqual([
        [box, laptop],
        [third, laptop],
      ]);
      // Only the member asked for is minted, and the one that answered is asked first next time.
      expect(registered).toEqual([laptop]);
      expect(catalog.records()).toEqual([record(laptop, third), record(vps, studio)]);

      const unreachable = yield* Effect.flip(open([laptop]));
      expect(unreachable).toBeInstanceOf(ConnectionBlockedError);
      expect(minted).toHaveLength(2);
    }),
  );
});

describe("makeNetworkMemberRenewals", () => {
  it.effect("tries once per attempt key and backs off exponentially up to a cap", () =>
    Effect.gen(function* () {
      const renewals = makeNetworkMemberRenewals({ baseMs: 1_000, capMs: 4_000 });
      let opened = 0;
      const open = Effect.sync(() => void opened++);
      const renew = (attemptKey: string) =>
        renewals.renew({ environmentId: laptop, attemptKey }, open);

      expect(yield* renew("hosts|0")).toBe(true);
      expect(yield* renew("hosts|0")).toBe(false);
      expect(opened).toBe(1);

      // Each new key waits 1s, 2s, then 4s, and never longer.
      for (const [index, wait] of [1_000, 2_000, 4_000, 4_000].entries()) {
        const next = yield* renew(`hosts|${index + 1}`).pipe(Effect.forkChild);
        yield* TestClock.adjust(wait - 1);
        expect(opened).toBe(index + 1);
        yield* TestClock.adjust(1);
        yield* Fiber.join(next);
        expect(opened).toBe(index + 2);
      }
    }),
  );
});
