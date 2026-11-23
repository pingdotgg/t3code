import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadLinkDestination, type ThreadLinkLookup } from "./threadLinkDestination";

const here = EnvironmentId.make("env-here");
const peer = EnvironmentId.make("env-peer");
const link = (href: string) => parseThreadLinkHref(href)!;
const lookup = (input: Partial<ThreadLinkLookup> = {}): ThreadLinkLookup => ({
  own: () => undefined,
  linkedLabel: async () => undefined,
  loaded: () => false,
  existing: async () => new Set(),
  ...input,
});

describe("resolveThreadLinkDestination", () => {
  it("reads a thread on a linked environment through the environment that shows the link", async () => {
    const linked = lookup({
      linkedLabel: async (via, id) => (via === here && id === peer ? "Peer" : undefined),
    });
    expect(
      await resolveThreadLinkDestination(link("t3-thread://v2/env-peer/t-1"), here, linked),
    ).toEqual({
      kind: "linked",
      ref: { environmentId: peer, threadId: ThreadId.make("t-1") },
      label: "Peer",
    });
    // A connection of this client's own opens it in place.
    expect(
      await resolveThreadLinkDestination(link("t3-thread://v2/env-peer/t-1"), here, {
        ...linked,
        own: () => ({ connected: true }),
      }),
    ).toMatchObject({ kind: "direct", ref: { environmentId: peer } });
  });

  it("opens a percent-escaped thread id by the spelling that exists", async () => {
    const escaped = link("t3-thread://v1/provider%3A1");
    const existing = (ids: ReadonlyArray<string>): ThreadLinkLookup =>
      lookup({ existing: async () => new Set(ids.map((id) => ThreadId.make(id))) });
    expect(await resolveThreadLinkDestination(escaped, here, existing(["provider:1"]))).toEqual({
      kind: "direct",
      ref: { environmentId: here, threadId: ThreadId.make("provider:1") },
    });
    expect(
      await resolveThreadLinkDestination(escaped, here, existing(["provider%3A1", "provider:1"])),
    ).toMatchObject({ ref: { threadId: "provider%3A1" } });
    // The client loads no archived thread, so a loaded sibling does not settle it.
    expect(
      await resolveThreadLinkDestination(escaped, here, {
        ...existing(["provider%3A1"]),
        loaded: (ref) => ref.threadId === "provider:1",
      }),
    ).toMatchObject({ ref: { threadId: "provider%3A1" } });
    // Nor does an unloaded spelling hide the loaded one when the environment cannot say.
    expect(
      await resolveThreadLinkDestination(escaped, here, {
        ...existing([]),
        loaded: (ref) => ref.threadId === "provider:1",
      }),
    ).toMatchObject({ ref: { threadId: "provider:1" } });
  });
});
