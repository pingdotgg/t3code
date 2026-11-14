import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { linkedEnvironmentStatus, returnLinkStatus } from "./LinkedEnvironmentsSettings.logic";

const SOURCE = EnvironmentId.make("source");
const NOW = DateTime.makeUnsafe("2026-11-14T12:00:00Z");
const back: PeerLinkSummary = {
  environmentId: SOURCE,
  label: "Source",
  urls: ["https://source.example.com"],
  access: "read-only",
  linkedAt: DateTime.makeUnsafe("2026-11-01T12:00:00Z"),
  expiresAt: DateTime.makeUnsafe("2026-12-01T12:00:00Z"),
  lastReachedAt: NOW,
  lastError: null,
  status: "reachable",
};

it("distinguishes an unchecked return from confirmed absence and independently scoped reverse links", () => {
  expect(returnLinkStatus(SOURCE, null, NOW).label).toBe("Return unchecked");
  expect(returnLinkStatus(SOURCE, [], NOW).label).toBe("One-way");
  expect(
    returnLinkStatus(SOURCE, [{ ...back, environmentId: EnvironmentId.make("other") }], NOW).label,
  ).toBe("One-way");
  expect(returnLinkStatus(SOURCE, [back], NOW)).toMatchObject({ label: "Two-way", warning: false });
  expect(returnLinkStatus(SOURCE, [back], NOW).detail).toContain("Read only");
  expect(returnLinkStatus(SOURCE, [{ ...back, access: "auto" }], NOW).detail).toContain("Auto");
  expect(
    returnLinkStatus(SOURCE, [{ ...back, access: "auto-accept-edits" }], NOW).detail,
  ).toContain("Auto-accept edits");
  expect(returnLinkStatus(SOURCE, [{ ...back, expiresAt: NOW }], NOW)).toMatchObject({
    label: "Return expired",
    warning: true,
  });
  expect(returnLinkStatus(SOURCE, [{ ...back, lastError: "Revoked" }], NOW)).toMatchObject({
    label: "Two-way",
    warning: true,
  });
  expect(returnLinkStatus(SOURCE, [{ ...back, status: "unreachable" }], NOW)).toMatchObject({
    label: "Two-way",
    warning: true,
  });
});

it("includes expiry warnings and recorded authentication failures in attention filtering", () => {
  expect(linkedEnvironmentStatus(back, NOW)).toMatchObject({ label: "Ready", attention: false });
  expect(
    linkedEnvironmentStatus({ ...back, expiresAt: DateTime.add(NOW, { days: 3 }) }, NOW),
  ).toMatchObject({ label: "Expires in 3d", attention: true });
  expect(linkedEnvironmentStatus({ ...back, lastError: "Revoked" }, NOW)).toMatchObject({
    label: "Last call failed",
    detail: "Revoked",
    attention: true,
  });
  expect(linkedEnvironmentStatus({ ...back, expiresAt: NOW }, NOW)).toMatchObject({
    label: "Expired",
    attention: true,
  });
});
