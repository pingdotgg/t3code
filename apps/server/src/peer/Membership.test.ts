import { EnvironmentId, type NetworkMember } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeRoster } from "./Membership.ts";

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
  write(box, "full-access", 10, 1, studio),
  write(box, "read-only", 10, 1, laptop),
  write(studio, "auto", 5, 0, laptop),
  write(studio, "revoked", 4, 9, box),
  // A tombstone beats an older widen that arrives after it.
  write(phone, "revoked", 8, 0, studio),
  write(phone, "full-access", 7, 3, laptop),
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
          (roster, entry) => mergeRoster(roster, [entry]),
          new Map(),
        ),
      ].toSorted(([a], [b]) => a.localeCompare(b)),
    );

    for (const result of results) expect(result).toEqual(results[0]);
    expect(Object.fromEntries(results[0]!.map(([id, entry]) => [id, entry.access]))).toEqual({
      [box]: "full-access",
      [studio]: "auto",
      [phone]: "revoked",
    });
  });
});
