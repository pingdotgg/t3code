import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { peerLinkHealth } from "./peerLinks.ts";

const now = DateTime.makeUnsafe("2026-10-06T12:00:00.000Z");
const link = (overrides: Partial<PeerLinkSummary>): PeerLinkSummary => ({
  environmentId: EnvironmentId.make("environment-box"),
  label: "Box",
  urls: ["https://box.example.ts.net"],
  access: "auto",
  linkedAt: DateTime.makeUnsafe("2026-09-20T12:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-10-20T12:00:00.000Z"),
  lastReachedAt: now,
  lastError: null,
  status: "reachable",
  ...overrides,
});

describe("peerLinkHealth", () => {
  it("warns only in the last days before a link expires", () => {
    expect(peerLinkHealth(link({}), now)).toEqual({ kind: "reachable", expiresInDays: null });
    expect(
      peerLinkHealth(link({ expiresAt: DateTime.makeUnsafe("2026-10-09T00:00:00.000Z") }), now),
    ).toEqual({ kind: "reachable", expiresInDays: 3 });
  });

  it("treats a link past its expiry as expired even if the server listed it earlier", () => {
    expect(
      peerLinkHealth(link({ expiresAt: DateTime.makeUnsafe("2026-10-06T11:00:00.000Z") }), now),
    ).toEqual({ kind: "expired" });
    expect(peerLinkHealth(link({ status: "expired" }), now)).toEqual({ kind: "expired" });
  });

  it("carries why an unreachable link failed last", () => {
    expect(
      peerLinkHealth(link({ status: "unreachable", lastError: "Box stopped answering." }), now),
    ).toEqual({ kind: "unreachable", detail: "Box stopped answering." });
  });

  it("flags a reachable link whose last call failed, such as after the peer revoked it", () => {
    expect(peerLinkHealth(link({ lastError: "Box rejected the link's session." }), now)).toEqual({
      kind: "failing",
      detail: "Box rejected the link's session.",
    });
  });
});
