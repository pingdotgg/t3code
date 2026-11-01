import { expect, it } from "@effect/vitest";

import { peersJoined } from "./tailnetGrants.ts";

const list = (ids: ReadonlyArray<string>, unidentified: ReadonlyArray<string | null> = []) => ({
  peers: ids.map((stableNodeId) => ({ stableNodeId })),
  unidentifiedPeerAddresses: unidentified,
});

it.each([
  { name: "the same devices", before: list(["a", "b"]), after: list(["b", "a"]), joined: false },
  { name: "a device left", before: list(["a", "b"]), after: list(["a"]), joined: false },
  { name: "a device joined", before: list(["a"]), after: list(["a", "b"]), joined: true },
  {
    name: "a peer with no ID replaced another",
    before: list(["a"], ["100.88.1.21"]),
    after: list(["a"], ["100.88.1.22"]),
    joined: true,
  },
  {
    name: "a second peer with no ID at the same address",
    before: list([], ["100.88.1.21"]),
    after: list([], ["100.88.1.21", "100.88.1.21"]),
    joined: true,
  },
  {
    name: "the same peers with no ID, one with no address",
    before: list([], [null, "100.88.1.21"]),
    after: list([], ["100.88.1.21", null]),
    joined: false,
  },
])(
  "a scan of the earlier list missed a device when $name: $joined",
  ({ before, after, joined }) => {
    expect(peersJoined(before, after)).toBe(joined);
  },
);
