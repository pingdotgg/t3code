import { EnvironmentId, type NetworkMember } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

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
