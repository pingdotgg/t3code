import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withInstanceIdentity } from "./instanceIdentity.ts";
import type { ServerProviderDraft } from "./snapshotProbe.ts";

const stamp = (displayName: string | undefined) =>
  withInstanceIdentity({
    instanceId: ProviderInstanceId.make("codex_pool"),
    driverKind: ProviderDriverKind.make("codex"),
    displayName,
    accentColor: undefined,
    continuationGroupKey: "codex",
  })({ displayName: "Codex" } as ServerProviderDraft);

describe("withInstanceIdentity", () => {
  // regression: #34507 clients could not tell an explicit "Codex" from the driver label
  it("marks only a configured display name", () => {
    expect(stamp("Codex")).toMatchObject({ displayName: "Codex", displayNameConfigured: true });
    const unnamed = stamp(undefined);
    expect(unnamed.displayName).toBe("Codex");
    expect(unnamed.displayNameConfigured).toBeUndefined();
  });
});
