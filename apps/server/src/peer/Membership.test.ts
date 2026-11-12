import { it as effectIt } from "@effect/vitest";
import { EnvironmentId, type NetworkMember } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Membership from "./Membership.ts";
import { mergeMembers } from "./Membership.ts";

const laptop = EnvironmentId.make("env-laptop");
const studio = EnvironmentId.make("env-studio");
const box = EnvironmentId.make("env-box");
const phone = EnvironmentId.make("env-phone");

const write = (
  environmentId: EnvironmentId,
  access: NetworkMember["access"],
  wallMs: number,
  counter: number,
  by: EnvironmentId,
): NetworkMember => ({
  environmentId,
  label: environmentId,
  nodeId: null,
  access,
  updatedAt: { wallMs, counter, node: by },
});

const writes = [
  write(box, "revoked", 10, 0, laptop),
  // Stamped later on a machine that had not seen the revocation.
  write(box, "full-access", 10, 1, studio),
  // The user restored it after seeing the revocation.
  { ...write(box, "auto", 11, 0, studio), restores: { wallMs: 10, counter: 0, node: laptop } },
  write(studio, "auto", 5, 0, laptop),
  write(studio, "revoked", 4, 9, box),
  write(phone, "revoked", 8, 0, studio),
  // A later narrowing that missed the revocation does not undo it.
  write(phone, "read-only", 9, 0, laptop),
];

const permutations = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, index) =>
        permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]),
      );

describe("mergeRoster", () => {
  it("converges on the same roster whatever order writes arrive in", () => {
    const results = permutations(writes).map((order) =>
      // One write at a time, as gossip delivers them.
      [
        ...order.reduce<ReadonlyMap<EnvironmentId, NetworkMember>>(
          (roster, entry) => mergeMembers(roster, [entry]),
          new Map(),
        ),
      ].toSorted(([a], [b]) => a.localeCompare(b)),
    );

    for (const result of results) expect(result).toEqual(results[0]);
    expect(Object.fromEntries(results[0]!.map(([id, entry]) => [id, entry.access]))).toEqual({
      [box]: "auto",
      [studio]: "revoked",
      [phone]: "revoked",
    });
  });
});

const layerMembership = Membership.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(laptop),
    }),
  ),
);

describe("the access an older build sees", () => {
  // An older build reads only `tailnet_device_policy`, and lets in a machine with no row there at
  // its default, full access. So every level here is written there too.
  effectIt.effect("follows every member write, narrowed by this machine's limit", () =>
    Effect.gen(function* () {
      const membership = yield* Membership.Membership;
      const sql = yield* SqlClient.SqlClient;
      const legacy = (environmentId: EnvironmentId) =>
        sql<{ readonly access: string; readonly updated_by: string }>`
          SELECT access, updated_by FROM tailnet_device_policy WHERE environment_id = ${environmentId}
        `.pipe(Effect.map((rows) => rows.map((row) => [row.access, row.updated_by])));
      const put = (environmentId: EnvironmentId, access: NetworkMember["access"]) =>
        membership.put({ environmentId, label: environmentId, nodeId: null, access });

      yield* put(box, "full-access");
      yield* put(box, "revoked");
      expect(yield* legacy(box)).toEqual([["revoked", laptop]]);

      yield* put(box, "auto");
      yield* membership.setLimit(box, "read-only");
      expect(yield* legacy(box)).toEqual([["read-only", laptop]]);

      // A narrowing merged from another machine lands there too.
      yield* put(studio, "full-access");
      yield* membership.merge(phone, {
        members: [write(studio, "approval-required", Number.MAX_SAFE_INTEGER, 0, phone)],
        apps: [],
      });
      expect(yield* legacy(studio)).toEqual([["approval-required", phone]]);
    }).pipe(Effect.provide(layerMembership)),
  );

  effectIt.effect("follows machines linked here only, and forgetting one", () =>
    Effect.gen(function* () {
      const membership = yield* Membership.Membership;
      const sql = yield* SqlClient.SqlClient;
      const legacy = (environmentId: EnvironmentId) =>
        sql<{ readonly access: string }>`
          SELECT access FROM tailnet_device_policy WHERE environment_id = ${environmentId}
        `.pipe(Effect.map((rows) => rows.map((row) => row.access)));

      yield* membership.putLocal({
        environmentId: box,
        label: "Box",
        nodeId: "n-box",
        access: "read-only",
      });
      expect(yield* legacy(box)).toEqual(["read-only"]);
      // Forgotten here, it is let in nowhere, not at the older build's default.
      yield* membership.forgetLocal(box);
      expect(yield* legacy(box)).toEqual(["revoked"]);

      // A member's own entry decides, whatever link it also has here.
      yield* membership.put({
        environmentId: studio,
        label: "Studio",
        nodeId: null,
        access: "auto",
      });
      yield* membership.forgetLocal(studio);
      expect(yield* legacy(studio)).toEqual(["auto"]);
    }).pipe(Effect.provide(layerMembership)),
  );
});
