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
  followedNetworks,
  makeNetworkMemberRenewals,
  makeNetworkMembers,
  networkMemberStatus,
  openNetworkMember,
  openingHosts,
  releaseNetworkMember,
  unboundMembers,
} from "./networkMembers.ts";

const studio = EnvironmentId.make("env-studio");
const box = EnvironmentId.make("env-box");
const laptop = EnvironmentId.make("env-laptop");
const vps = EnvironmentId.make("env-vps");
const app = "app-phone";
const admin = EnvironmentId.make("env-admin");

const member = (environmentId: EnvironmentId, access: TailnetDeviceAccess): NetworkMember => ({
  environmentId,
  label: environmentId,
  nodeId: `node-${environmentId}`,
  access,
  // A revocation stamped by the member itself reads as leaving; these are an admin's.
  updatedAt: { wallMs: 1, counter: 0, node: access === "revoked" ? admin : environmentId },
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
  opener: { kind: "app", appId: app },
});
const inApp = (entry: NetworkMemberRecord, appId: string): NetworkMemberRecord => ({
  ...entry,
  opener: { kind: "app", appId },
});
const opened = (environmentId: EnvironmentId) => ({ environmentId, sessionExpiresAt: 30 });
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

  it.effect("drops a member whose newest entry is a revocation, even while another lists it", () =>
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

  it.effect("keeps a member another host restored after a stale host's revocation", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([record(laptop, studio)]);
      catalog.saved.add(studio).add(box).add(laptop);
      const revokedAt = { wallMs: 2, counter: 0, node: studio };
      const stale = {
        ...device(laptop, "revoked"),
        member: { ...member(laptop, "revoked"), updatedAt: revokedAt },
      };
      const restored = {
        ...device(laptop),
        member: {
          ...member(laptop, "full-access"),
          updatedAt: { wallMs: 3, counter: 0, node: box },
          restores: revokedAt,
        },
      };

      yield* catalog.follow([report(studio, [stale]), report(box, [restored])]);
      expect(catalog.records()).toEqual([record(laptop, box)]);
      expect(catalog.forgotten).toEqual([]);
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

      // The other network is followed on its own; none of these hosts speaks for this one.
      expect(followedNetworks([other, off, pairing, appRevoked])).toEqual([
        { appId: "app-other", reports: [other] },
      ]);
      // A host revoking this app is a positive signal; see "old network revoke then new join".
      yield* catalog.follow([other, off, pairing]);
      expect(catalog.records()).toEqual([record(laptop, studio)]);
      expect(catalog.forgotten).toEqual([]);

      // Each network follows its own hosts: the other one's revocation of the laptop is not ours.
      expect(followedNetworks([report(studio, []), other]).map((network) => network.appId)).toEqual(
        ["app-other", app],
      );
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

      const desk = EnvironmentId.make("env-desk");

      // Networks are disjoint: the new one lists none of the old one's machines.
      yield* catalog.follow([
        withApps(studio, [device(laptop), device(vps), device(box)], app, "revoked"),
        withApps(third, [device(box), device(desk)], appNew, "full-access"),
      ]);

      expect(catalog.records()).toEqual([inApp(record(desk, third), appNew)]);
      expect(followedNetworks([withApps(third, [], appNew, "full-access")])).toMatchObject([
        { appId: appNew },
      ]);
      // Neither the hand-paired box nor the opened laptop's saved connection is forgotten.
      expect(catalog.forgotten).toEqual([]);
      expect([...catalog.saved]).toEqual([studio, laptop, box]);
    }),
  );

  // Apps are only ever narrowed: a revoked app id stays revoked on every server, and widening
  // pairs a new id. So a revocation disowns it whatever its stamp, as the servers converge.
  it.effect("a revocation of this app disowns it however it is stamped", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([record(vps, studio)]);
      catalog.saved.add(studio).add(box);
      const stale = withApps(studio, [device(vps), device(laptop)], app, "revoked");
      const current = withApps(box, [], app, "full-access");
      const newer = {
        ...current,
        roster: {
          ...current.roster,
          apps: current.roster.apps.map((entry) => ({
            ...entry,
            updatedAt: { wallMs: 2, counter: 0, node: box },
          })),
        },
      };

      yield* catalog.follow([stale, newer]);
      expect(catalog.records()).toEqual([]);
      // Saved connections stay with the user.
      expect(catalog.forgotten).toEqual([]);
    }),
  );

  it.effect("re-pairing the app moves the network to its new id", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([record(laptop, studio), record(vps, studio)]);
      catalog.saved.add(studio).add(laptop);
      // The old app is revoked and hidden everywhere, so the host lists only the new one.
      const repaired = withApps(studio, [device(laptop), device(vps)], appNew, "full-access");

      yield* catalog.follow([repaired]);
      expect(catalog.records()).toEqual([
        inApp(record(laptop, studio), appNew),
        inApp(record(vps, studio), appNew),
      ]);
      expect(followedNetworks([repaired])).toEqual([{ appId: appNew, reports: [repaired] }]);
      expect(catalog.forgotten).toEqual([]);
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

describe("round 4", () => {
  const desk = EnvironmentId.make("env-desk");
  const third = EnvironmentId.make("env-third");
  const appOther = "app-other";
  const inOther = (host: EnvironmentId, devices: ReadonlyArray<TailnetDevice>) =>
    report(host, devices, { callerAppId: appOther });

  it.effect("opens through a host this session may write on, without an app id", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog();
      const desktop = report(studio, [device(laptop)], { callerAppId: null, apps: [] });
      const minted: Array<EnvironmentId> = [];
      const environmentId = yield* openNetworkMember({
        environmentId: laptop,
        label: "Laptop",
        hosts: openingHosts([desktop], (host) => host === studio),
        mint: (via, target) =>
          Effect.sync(() => void minted.push(via)).pipe(Effect.as(credential(target))),
        register: (value) => Effect.succeed(opened(value.environmentId)),
      }).pipe(Effect.provideService(NetworkMembers, catalog.members));

      expect(environmentId).toBe(laptop);
      expect(minted).toEqual([studio]);
      // The open is a record keyed by the relaying host, so it is renewed and its state shown.
      expect(catalog.records()).toEqual([
        {
          environmentId: laptop,
          label: "Laptop",
          via: studio,
          opener: { kind: "host" },
          sessionExpiresAt: 30,
        },
      ]);
      // Without write access the same session is not asked.
      expect(openingHosts([desktop], () => false)).toEqual([]);
    }),
  );

  it.effect("a foreign host never repins records; a machine that moved there is released", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([record(laptop, studio), record(vps, studio)]);
      catalog.saved.add(studio).add(laptop);

      // The pinned network's hosts are offline; the foreign host holds a tombstone of the laptop.
      yield* catalog.follow([inOther(third, [device(laptop, "revoked"), device(desk)])]);
      expect(
        catalog
          .records()
          .filter((entry) => entry.opener.kind === "app" && entry.opener.appId === app),
      ).toEqual([record(laptop, studio), record(vps, studio)]);

      // The laptop moved while its network is silent: released, its saved session kept, the rest stay.
      yield* catalog.follow([inOther(third, [device(laptop), device(desk)])]);
      expect(catalog.records()).toEqual([
        record(vps, studio),
        inApp(record(desk, third), appOther),
      ]);
      expect(catalog.forgotten).toEqual([]);
    }),
  );

  it.effect("follows every network that still takes this app", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog();
      catalog.saved.add(studio).add(third);

      yield* catalog.follow([report(studio, [device(laptop)]), inOther(third, [device(desk)])]);
      expect(catalog.records()).toEqual([
        inApp(record(desk, third), appOther),
        record(laptop, studio),
      ]);
    }),
  );

  it.effect("keeps a member no machine can open yet out of the records", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog();
      catalog.saved.add(studio);
      const unbound = {
        ...device(laptop),
        member: { ...member(laptop, "full-access"), nodeId: null },
      };

      yield* catalog.follow([report(studio, [unbound, device(vps)])]);
      expect(catalog.records()).toEqual([record(vps, studio)]);
      expect(unboundMembers([report(studio, [unbound, device(vps)])])).toEqual(new Set([laptop]));
    }),
  );
});

describe("round 5", () => {
  const leftLaptop = {
    ...device(laptop, "revoked"),
    member: { ...member(laptop, "revoked"), updatedAt: { wallMs: 2, counter: 0, node: laptop } },
  };

  it.effect("a member that left keeps its saved session and is no longer managed", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([{ ...record(laptop, studio), sessionExpiresAt: 30 }]);
      catalog.saved.add(studio).add(laptop);

      yield* catalog.follow([report(studio, [leftLaptop])]);
      yield* catalog.follow([report(studio, [])]);
      expect(catalog.records()).toEqual([
        { ...record(laptop, studio), sessionExpiresAt: 30, left: true },
      ]);
      expect(catalog.forgotten).toEqual([]);

      // Added again, it is listed live and managed once more.
      yield* catalog.follow([report(studio, [device(laptop)])]);
      expect(catalog.records()).toEqual([{ ...record(laptop, studio), sessionExpiresAt: 30 }]);
    }),
  );

  it("a refused session outranks what the roster says", () => {
    const opened = record(laptop, studio);
    const left = { ...opened, left: true as const };
    expect(networkMemberStatus(opened, undefined, true)).toBe("unopened");
    expect(networkMemberStatus(opened, { needsPairing: false }, true)).toBe("open");
    expect(networkMemberStatus(left, { needsPairing: false }, true)).toBe("left");
    expect(networkMemberStatus(opened, { needsPairing: true }, true)).toBe("reopen");
    // Cut by another client's Leave, or with no host here to open it: nothing is kept for it.
    expect(networkMemberStatus(left, { needsPairing: true }, true)).toBe("refused");
    expect(networkMemberStatus(opened, { needsPairing: true }, false)).toBe("refused");
  });

  it.effect("an app-less open follows the roster of the host that opened it", () =>
    Effect.gen(function* () {
      const box2 = EnvironmentId.make("env-box2");
      const appless = (environmentId: EnvironmentId): NetworkMemberRecord => ({
        environmentId,
        label: environmentId,
        via: studio,
        opener: { kind: "host" },
      });
      const catalog = yield* makeCatalog([appless(laptop), appless(vps), appless(box2)]);
      catalog.saved.add(studio).add(laptop).add(vps).add(box2);
      const desktop = (devices: ReadonlyArray<TailnetDevice>) =>
        report(studio, devices, { callerAppId: null, apps: [] });

      // A host this session is not on says nothing; its own host's switch off says nothing.
      yield* catalog.follow([report(box, [device(laptop, "revoked")])]);
      yield* catalog.follow([
        { ...desktop([]), roster: { ...desktop([]).roster, enabled: false } },
      ]);
      expect(catalog.records()).toHaveLength(3);

      yield* catalog.follow([desktop([leftLaptop, device(vps, "revoked"), device(box2)])]);
      expect(catalog.records()).toEqual([{ ...appless(laptop), left: true }, appless(box2)]);
      expect(catalog.forgotten).toEqual([vps]);
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
          hosts: hosts.map((host) => ({ host, appId: app })),
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
              Effect.as(opened(value.environmentId)),
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
      expect(catalog.records()).toEqual([
        { ...record(laptop, third), sessionExpiresAt: 30 },
        record(vps, studio),
      ]);

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
