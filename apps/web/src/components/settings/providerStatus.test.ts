import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { getProviderSummary, PROVIDER_STATUS_STYLES } from "./providerStatus";

describe("providerStatus", () => {
  it("renders pending providers as an in-progress availability check", () => {
    const provider = {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      status: "pending",
      enabled: true,
      installed: false,
      auth: { status: "unknown" },
      checkedAt: "1970-01-01T00:00:00.000Z",
      version: null,
      models: [],
      slashCommands: [],
      skills: [],
    } as const satisfies ServerProvider;

    expect(PROVIDER_STATUS_STYLES.pending).toEqual({
      dot: "bg-muted-foreground/50",
    });
    expect(getProviderSummary(provider)).toEqual({
      headline: "Checking provider status",
      detail: "Waiting for installation and authentication details.",
    });
  });
});
