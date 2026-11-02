import { expect, it } from "@effect/vitest";

import { peersJoined } from "./tailnetGrants.ts";

// Peers with no ID as `key@address`, or a bare key for one with no address.
const list = (ids: ReadonlyArray<string>, unidentified: ReadonlyArray<string> = []) => ({
  peers: ids.map((stableNodeId) => ({ stableNodeId })),
  unidentifiedPeers: unidentified.map((peer) => {
    const [key = "", address] = peer.split("@");
    return { key, address: address ?? null };
  }),
});

it.each([
  { name: "the same devices", before: list(["a", "b"]), after: list(["b", "a"]), joined: false },
  { name: "a device left", before: list(["a", "b"]), after: list(["a"]), joined: false },
  { name: "a device joined", before: list(["a"]), after: list(["a", "b"]), joined: true },
  {
    name: "a peer with no ID replaced another",
    before: list(["a"], ["k1@100.88.1.21"]),
    after: list(["a"], ["k2@100.88.1.22"]),
    joined: true,
  },
  {
    name: "another node with no ID took the same address",
    before: list([], ["k1@100.88.1.21"]),
    after: list([], ["k2@100.88.1.21"]),
    joined: true,
  },
  {
    name: "the same peers with no ID, one with no address",
    before: list([], ["k1", "k2@100.88.1.21"]),
    after: list([], ["k2@100.88.1.21", "k1"]),
    joined: false,
  },
])(
  "a scan of the earlier list missed a device when $name: $joined",
  ({ before, after, joined }) => {
    expect(peersJoined(before, after)).toBe(joined);
  },
);
