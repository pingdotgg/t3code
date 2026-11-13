import { expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

it("keeps a revision across snapshots and replaces it when the instance is rebuilt", () => {
  const input = {
    instanceId: ProviderInstanceId.make("opencode"),
    driverKind: ProviderDriverKind.make("opencode"),
    displayName: undefined,
    accentColor: undefined,
    continuationGroupKey: "opencode",
  };
  const snapshot = {
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt: "2026-11-06T00:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const stamp = withInstanceIdentity(input);
  const initial = stamp(snapshot);
  const updated = stamp({ ...snapshot, checkedAt: "2026-11-06T00:01:00Z" });
  const rebuilt = withInstanceIdentity({ ...input, displayName: "Renamed" })(snapshot);
  expect(initial.instanceRevision).toBeDefined();
  expect(updated.instanceRevision).toBe(initial.instanceRevision);
  expect(rebuilt.instanceRevision).not.toBe(initial.instanceRevision);
});
