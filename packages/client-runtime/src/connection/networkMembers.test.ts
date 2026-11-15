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
  dueNetworkMemberOpens,
  followNetworkRoster,
  followedNetworks,
  makeNetworkMemberRenewals,
  makeNetworkMembers,
  networkMemberActivityLabel,
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
    const follow = (
      reports: ReadonlyArray<NetworkRosterReport>,
      catalog = members,
      mayWrite: (host: EnvironmentId) => boolean = () => false,
    ) =>
      followNetworkRoster({
        reports,
        savedEnvironmentIds: Effect.sync(() => new Set(saved)),
        forget: (environmentId) => Effect.sync(() => void forgotten.push(environmentId)),
        mayWrite,
      }).pipe(Effect.provideService(NetworkMembers, catalog));
    return { members, forgotten, saved, follow, records: () => stored };
  });
/** Saved environments, all enabled with an accepted session unless named otherwise. */
const savedState = (
  environmentIds: ReadonlyArray<EnvironmentId>,
  overrides: ReadonlyArray<
    readonly [EnvironmentId, { needsPairing?: boolean; enabled?: boolean }]
  > = [],
) => {
  const state = new Map<EnvironmentId, { needsPairing: boolean; enabled: boolean }>(
    environmentIds.map((id) => [id, { needsPairing: false, enabled: true }]),
  );
  for (const [id, value] of overrides) state.set(id, { ...state.get(id)!, ...value });
  return state;
};
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
  it.effect("keeps members it lacks as records due to open, and skips the user's own", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog();
      catalog.saved.add(studio).add(box);
      const reports = [report(studio, [device(box), device(laptop)])];
      yield* catalog.follow(reports);

      expect(catalog.records()).toEqual([record(laptop, studio)]);
      expect(
        dueNetworkMemberOpens({
          records: catalog.records(),
          reports,
          hosts: [{ host: studio, appId: app }],
          saved: savedState([studio, box]),
        }).map((due) => due.environmentId),
      ).toEqual([laptop]);

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
    const status = (
      member: NetworkMemberRecord,
      saved: { readonly needsPairing: boolean } | undefined,
      canOpen: boolean,
    ) => networkMemberStatus({ record: member, saved, canOpen }).status;
    expect(status(opened, { needsPairing: false }, true)).toBe("open");
    expect(status(left, { needsPairing: false }, true)).toBe("left");
    expect(status(opened, { needsPairing: true }, true)).toBe("reopen");
    // Cut by another client's Leave, or with no host here to open it: nothing is kept for it.
    expect(status(left, { needsPairing: true }, true)).toBe("refused");
    expect(status(opened, { needsPairing: true }, false)).toBe("refused");
  });

  it("says connecting only while an open runs or is about to", () => {
    const member = record(laptop, studio);
    const refused = { needsPairing: true };
    const failed = { phase: "failed", reason: "Laptop does not answer from this device." } as const;
    const state = (input: Partial<Parameters<typeof networkMemberStatus>[0]>) =>
      networkMemberStatus({ record: member, saved: undefined, canOpen: true, ...input });

    for (const saved of [undefined, refused]) {
      // Due and not tried yet, or running now.
      expect(state({ saved, due: true }).status).toBe("connecting");
      expect(state({ saved, attempt: { phase: "connecting" } }).status).toBe("connecting");
      // Failed and waiting out the backoff, though still due: retrying, with the reason.
      expect(state({ saved, due: true, attempt: failed })).toEqual({
        status: "retrying",
        reason: failed.reason,
      });
      // Agent links paused on the hosts: nothing opens it, whatever the last attempt did.
      expect(state({ saved, canOpen: false, paused: true, attempt: failed }).status).toBe("paused");
    }
    expect(state({}).status).toBe("idle");
    expect(state({ canOpen: false, attempt: failed }).status).toBe("idle");
    expect(state({ attempt: failed, unreachable: true }).status).toBe("unreachable");
    expect(state({ record: { ...member, off: true }, due: true }).status).toBe("off");

    expect(
      [
        state({ due: true }),
        state({ attempt: failed }),
        state({ attempt: { phase: "failed", reason: null } }),
        state({ canOpen: false, paused: true }),
        state({ unreachable: true }),
        state({ saved: { needsPairing: false } }),
      ].map((value) => networkMemberActivityLabel(value, "phone")),
    ).toEqual([
      "Connecting…",
      "Can't connect · retrying · Laptop does not answer from this device",
      "Can't connect · retrying",
      "Agent links paused",
      "Can't reach from this phone",
      null,
    ]);
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
      let started = 0;
      const open = Effect.sync(() => void opened++);
      // "Connecting…" starts with the attempt, not while the backoff is waited out.
      const renew = (attemptKey: string) =>
        renewals.renew(
          { environmentId: laptop, attemptKey },
          open,
          Effect.sync(() => void started++),
        );

      expect(yield* renew("hosts|0")).toBe(true);
      expect(yield* renew("hosts|0")).toBe(false);
      expect(opened).toBe(1);

      // Each new key waits 1s, 2s, then 4s, and never longer.
      for (const [index, wait] of [1_000, 2_000, 4_000, 4_000].entries()) {
        const next = yield* renew(`hosts|${index + 1}`).pipe(Effect.forkChild);
        yield* TestClock.adjust(wait - 1);
        expect([opened, started]).toEqual([index + 1, index + 1]);
        yield* TestClock.adjust(1);
        yield* Fiber.join(next);
        expect([opened, started]).toEqual([index + 2, index + 2]);
      }
    }),
  );

  it.effect("a failed open is tried again after each backoff while the member is still due", () =>
    Effect.gen(function* () {
      const renewals = makeNetworkMemberRenewals({ baseMs: 1_000, capMs: 4_000 });
      const renewal = { environmentId: laptop, attemptKey: "hosts|0" };
      // The machine joined a moment ago: its host has no link to it for the first two opens.
      let opens = 0;
      const open = Effect.suspend(() => (++opens < 3 ? Effect.fail("no link yet") : Effect.void));
      let due = true;
      const stillDue = Effect.sync(() => (due ? renewal : undefined));

      const fiber = yield* renewals
        .renew(renewal, open, Effect.void, stillDue)
        .pipe(Effect.forkChild);
      yield* TestClock.adjust(999);
      expect(opens).toBe(1);
      yield* TestClock.adjust(1);
      expect(opens).toBe(2);
      yield* TestClock.adjust(2_000);
      expect(yield* Fiber.join(fiber)).toBe(true);
      expect(opens).toBe(3);

      // No longer due (offline, switched off, gone from the roster): the failure ends it.
      due = false;
      opens = 0;
      const stopped = yield* renewals
        .renew({ ...renewal, attemptKey: "hosts|1" }, open, Effect.void, stillDue)
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(4_000);
      expect(yield* Fiber.join(stopped)).toBe("no link yet");
      expect(opens).toBe(1);
    }),
  );
});

describe("opening members without a click", () => {
  const desktop = (devices: ReadonlyArray<TailnetDevice>) =>
    report(studio, devices, { callerAppId: null, apps: [] });
  const hostRecord = (environmentId: EnvironmentId): NetworkMemberRecord => ({
    environmentId,
    label: environmentId,
    via: studio,
    opener: { kind: "host" },
  });
  const due = (
    records: ReadonlyArray<NetworkMemberRecord>,
    reports: ReadonlyArray<NetworkRosterReport>,
    saved: ReturnType<typeof savedState>,
  ) =>
    dueNetworkMemberOpens({
      records,
      reports,
      hosts: openingHosts(reports, (host) => host === studio),
      saved,
    });

  it.effect("a desktop session following a roster gets a record per member", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog();
      catalog.saved.add(studio);
      const reports = [desktop([device(laptop), device(vps)])];

      // Only where it may write the network, as the server requires of an app-less open.
      yield* catalog.follow(reports);
      expect(catalog.records()).toEqual([]);
      yield* catalog.follow(reports, catalog.members, (host) => host === studio);
      expect(catalog.records()).toEqual([hostRecord(laptop), hostRecord(vps)]);
    }),
  );

  it.effect("an unopened reachable member is opened once without a click", () =>
    Effect.gen(function* () {
      const reports = [desktop([device(laptop)])];
      const [renewal, ...rest] = due([hostRecord(laptop)], reports, savedState([studio]));
      expect(rest).toEqual([]);
      const renewals = makeNetworkMemberRenewals();
      let opens = 0;
      const open = Effect.sync(() => void opens++);
      expect(yield* renewals.renew(renewal!, open)).toBe(true);
      // The same roster again is no new reason to try.
      const [again] = due([hostRecord(laptop)], reports, savedState([studio]));
      expect(yield* renewals.renew(again!, open)).toBe(false);
      expect(opens).toBe(1);
      // Offline, it is not even probed until it comes back.
      const offline = [desktop([{ ...device(laptop), status: "offline" }])];
      expect(due([hostRecord(laptop)], offline, savedState([studio]))).toEqual([]);
    }),
  );

  it("a switched-off member is never opened", () => {
    const reports = [desktop([device(laptop), device(vps)])];
    const off = { ...hostRecord(laptop), off: true as const };
    // Off with no saved entry, or saved and disabled here.
    expect(due([off], reports, savedState([studio]))).toEqual([]);
    expect(
      due(
        [hostRecord(vps)],
        reports,
        savedState([studio, vps], [[vps, { enabled: false, needsPairing: true }]]),
      ),
    ).toEqual([]);
  });

  it.effect("an unreachable member triggers no mint", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([hostRecord(laptop)]);
      let mints = 0;
      const failure = yield* Effect.flip(
        openNetworkMember({
          environmentId: laptop,
          hosts: [{ host: studio, appId: null }],
          reachable: Effect.succeed(false),
          mint: (_via, target) =>
            Effect.sync(() => void mints++).pipe(Effect.as(credential(target))),
          register: (value) => Effect.succeed(opened(value.environmentId)),
        }).pipe(Effect.provideService(NetworkMembers, catalog.members)),
      );
      expect(mints).toBe(0);
      expect(failure._tag).toBe("ConnectionTransientError");
      expect(catalog.records()).toEqual([hostRecord(laptop)]);
    }),
  );

  it.effect("five members never run more than two mints at once", () =>
    Effect.gen(function* () {
      const renewals = makeNetworkMemberRenewals();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let most = 0;
      let done = 0;
      const open = Effect.sync(() => {
        active++;
        most = Math.max(most, active);
      }).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.ensuring(Effect.sync(() => void (active--, done++))),
      );
      const members = ["a", "b", "c", "d", "e"].map((id) => EnvironmentId.make(`env-${id}`));
      const fibers = yield* Effect.forEach(members, (environmentId) =>
        renewals.renew({ environmentId, attemptKey: "hosts|0" }, open).pipe(Effect.forkChild),
      );
      yield* Effect.yieldNow;
      expect(active).toBe(2);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.joinAll(fibers);
      expect(done).toBe(5);
      expect(most).toBe(2);
    }),
  );

  it.effect("a refused hand-paired member is re-opened and becomes managed", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog();
      // Paired by hand, so it is no record; its session was refused.
      const reports = [desktop([device(laptop)])];
      const saved = savedState([studio, laptop], [[laptop, { needsPairing: true }]]);
      catalog.saved.add(studio).add(laptop);
      yield* catalog.follow(reports, catalog.members, (host) => host === studio);
      expect(catalog.records()).toEqual([]);

      expect(due([], reports, saved).map((entry) => entry.environmentId)).toEqual([laptop]);
      yield* openNetworkMember({
        environmentId: laptop,
        label: laptop,
        hosts: openingHosts(reports, (host) => host === studio),
        mint: (_via, target) => Effect.succeed(credential(target)),
        register: (value) => Effect.succeed(opened(value.environmentId)),
      }).pipe(Effect.provideService(NetworkMembers, catalog.members));
      expect(catalog.records()).toEqual([{ ...hostRecord(laptop), sessionExpiresAt: 30 }]);
    }),
  );
});
