import {
  EnvironmentId,
  type NetworkMember,
  type TailnetDevice,
  type TailnetDeviceAccess,
  type TailnetDeviceClientCredential,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ConnectionBlockedError } from "./model.ts";
import {
  type NetworkMemberRecord,
  type NetworkRoster,
  NetworkMembers,
  followNetworkRoster,
  makeNetworkMembers,
  openNetworkMember,
} from "./networkMembers.ts";

const studio = EnvironmentId.make("env-studio");
const box = EnvironmentId.make("env-box");
const laptop = EnvironmentId.make("env-laptop");
const vps = EnvironmentId.make("env-vps");

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
const roster = (host: EnvironmentId, devices: ReadonlyArray<TailnetDevice>): NetworkRoster => ({
  selfMember: member(host, "full-access"),
  devices,
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
    const follow = (
      host: EnvironmentId,
      report: NetworkRoster | null,
      saved: ReadonlyArray<EnvironmentId>,
    ) =>
      followNetworkRoster({
        host,
        roster: report,
        savedEnvironmentIds: new Set(saved),
        forget: (environmentId) => Effect.sync(() => void forgotten.push(environmentId)),
      }).pipe(Effect.provideService(NetworkMembers, members));
    return { members, forgotten, follow, records: () => stored };
  });

describe("followNetworkRoster", () => {
  it.effect("keeps members it lacks as records without opening any, and skips the user's own", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog();
      yield* catalog.follow(studio, roster(studio, [device(box), device(laptop)]), [studio, box]);

      expect(catalog.records()).toEqual([{ environmentId: laptop, label: laptop, via: studio }]);

      // Revoking or dropping the user's own saved box never forgets it.
      yield* catalog.follow(studio, roster(studio, [device(box, "revoked")]), [studio, box]);
      yield* catalog.follow(studio, roster(studio, []), [studio, box]);
      expect(catalog.forgotten).toEqual([]);
    }),
  );

  it.effect("drops a member revoked anywhere or removed from the roster that brought it", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([
        { environmentId: laptop, label: laptop, via: studio },
        { environmentId: vps, label: vps, via: studio },
        { environmentId: box, label: box, via: vps },
      ]);
      const saved = [studio, laptop, vps];

      // Another member's roster revokes the laptop; one that omits the vps is not its host.
      yield* catalog.follow(box, roster(box, [device(laptop, "revoked")]), [...saved, box]);
      expect(catalog.records().map((record) => record.environmentId)).toEqual([vps, box]);

      yield* catalog.follow(studio, roster(studio, [device(box)]), saved);
      expect(catalog.records().map((record) => record.environmentId)).toEqual([box]);
      // Only opened members have a saved connection to forget.
      expect(catalog.forgotten).toEqual([laptop, vps]);
    }),
  );

  it.effect("drops what a host brought once it stops offering the network", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([
        { environmentId: laptop, label: laptop, via: studio },
        { environmentId: vps, label: vps, via: box },
      ]);
      yield* catalog.follow(studio, null, [studio, laptop]);

      expect(catalog.records()).toEqual([{ environmentId: vps, label: vps, via: box }]);
      expect(catalog.forgotten).toEqual([laptop]);
    }),
  );
});

describe("openNetworkMember", () => {
  it.effect("asks another connected member when the one that listed it is unreachable", () =>
    Effect.gen(function* () {
      const catalog = yield* makeCatalog([
        { environmentId: laptop, label: laptop, via: studio },
        { environmentId: vps, label: vps, via: studio },
      ]);
      const minted: Array<readonly [EnvironmentId, EnvironmentId]> = [];
      const registered: Array<EnvironmentId> = [];
      const open = (connected: ReadonlyArray<EnvironmentId>) =>
        openNetworkMember({
          environmentId: laptop,
          connectedEnvironmentIds: new Set(connected),
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

      // The studio is offline: the box refuses, the third member mints.
      expect(yield* open([box, laptop, EnvironmentId.make("env-third")])).toBe(laptop);
      expect(minted).toEqual([
        [box, laptop],
        [EnvironmentId.make("env-third"), laptop],
      ]);
      // Only the member asked for is minted, and the one that answered is asked first next time.
      expect(registered).toEqual([laptop]);
      expect(catalog.records()).toEqual([
        { environmentId: laptop, label: laptop, via: EnvironmentId.make("env-third") },
        { environmentId: vps, label: vps, via: studio },
      ]);

      const unreachable = yield* Effect.flip(open([laptop]));
      expect(unreachable).toBeInstanceOf(ConnectionBlockedError);
      expect(minted).toHaveLength(2);
    }),
  );
});
