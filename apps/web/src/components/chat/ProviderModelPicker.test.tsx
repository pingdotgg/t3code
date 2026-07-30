import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "~/providerInstances";
import { shouldShowProviderInstanceBadge } from "./ProviderModelPicker";

const codexDriver = ProviderDriverKind.make("codex");

function instance(
  options: { accentColor?: string } = {},
): Pick<ProviderInstanceEntry, "driverKind" | "accentColor"> {
  return {
    driverKind: codexDriver,
    ...(options.accentColor ? { accentColor: options.accentColor } : {}),
  };
}

describe("shouldShowProviderInstanceBadge", () => {
  it("keeps the ordinary single-instance trigger visually calm", () => {
    const entry = instance();
    expect(shouldShowProviderInstanceBadge([entry], entry)).toBe(false);
  });

  it("disambiguates duplicate instances of the same driver", () => {
    const personal = instance();
    expect(shouldShowProviderInstanceBadge([instance(), personal], personal)).toBe(true);
  });

  it("shows a configured custom identity even for one instance", () => {
    const entry = instance({ accentColor: "#7c3aed" });
    expect(shouldShowProviderInstanceBadge([entry], entry)).toBe(true);
  });
});
