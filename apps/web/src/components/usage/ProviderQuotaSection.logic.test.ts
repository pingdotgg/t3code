import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderUsageStripItem } from "../sidebar/ProviderUsageStrip.logic";
import { resolveSelectedProviderQuotaItem } from "./ProviderQuotaSection.logic";

const codex = ProviderDriverKind.make("codex");

function item(id: string): ProviderUsageStripItem {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: codex,
    displayName: id,
    percentage: 64,
    headlineLabel: "Weekly limit",
    snapshot: null,
  };
}

describe("resolveSelectedProviderQuotaItem", () => {
  const items = [item("codex-personal"), item("codex-work")];

  it("selects the requested visible provider instance", () => {
    expect(
      resolveSelectedProviderQuotaItem(items, ProviderInstanceId.make("codex-work"))?.instanceId,
    ).toBe("codex-work");
  });

  it("falls back to the first settings-ordered provider when the request is unavailable", () => {
    expect(
      resolveSelectedProviderQuotaItem(items, ProviderInstanceId.make("removed"))?.instanceId,
    ).toBe("codex-personal");
  });

  it("returns null when there are no visible providers", () => {
    expect(resolveSelectedProviderQuotaItem([], ProviderInstanceId.make("codex-work"))).toBeNull();
  });
});
