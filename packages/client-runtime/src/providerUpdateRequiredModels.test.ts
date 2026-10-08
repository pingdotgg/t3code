import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatProviderUpdateRequiredNotice } from "./providerUpdateRequiredModels.ts";

describe("formatProviderUpdateRequiredNotice", () => {
  it("names the CLI and the version that unlocks every listed model", () => {
    expect(
      formatProviderUpdateRequiredNotice({
        driver: ProviderDriverKind.make("claudeAgent"),
        updateRequiredModels: [
          { slug: "a", name: "Model A", minVersion: "2.1.9" },
          { slug: "b", name: "Model B", minVersion: "2.1.10" },
        ],
      }),
    ).toBe("Update Claude Code to v2.1.10 or newer to use Model A and Model B.");
    expect(
      formatProviderUpdateRequiredNotice({ driver: ProviderDriverKind.make("codex") }),
    ).toBeNull();
  });
});
