import type { HermesSkillsProviderProjection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatSkillNames,
  formatSkillsReloadSummary,
  skillsBlockedDiagnostic,
  skillsNegotiationFooter,
} from "./HermesSkillsSettings.logic";

const provider = (
  overrides: Partial<HermesSkillsProviderProjection>,
): HermesSkillsProviderProjection => ({
  providerInstanceId: "hermes_main",
  displayName: "Hermes",
  profileKey: "work",
  status: "ready",
  protocolClassification: "supported",
  capabilities: { inventory: true, search: true, inspect: true, reload: true },
  skills: [],
  diagnostics: [],
  ...overrides,
});

describe("formatSkillsReloadSummary", () => {
  it("includes the total only when the gateway reports one", () => {
    expect(formatSkillsReloadSummary({ added: ["a"], removed: [], total: 4, output: null })).toBe(
      "1 added, 0 removed, 4 total",
    );
    expect(
      formatSkillsReloadSummary({ added: [], removed: ["b"], total: null, output: null }),
    ).toBe("0 added, 1 removed");
  });
});

describe("formatSkillNames", () => {
  it("joins names and hides empty lists", () => {
    expect(formatSkillNames(["a", "b"])).toBe("a, b");
    expect(formatSkillNames([])).toBeNull();
  });
});

describe("skillsBlockedDiagnostic", () => {
  it("returns no diagnostic for ready providers", () => {
    expect(skillsBlockedDiagnostic(provider({ status: "ready" }))).toBeNull();
  });

  it("surfaces the first diagnostic for blocked providers", () => {
    expect(
      skillsBlockedDiagnostic(
        provider({
          status: "unavailable",
          diagnostics: ["Gateway capabilities are not negotiated"],
        }),
      ),
    ).toBe("Gateway capabilities are not negotiated");
    expect(skillsBlockedDiagnostic(provider({ status: "error", diagnostics: [] }))).toBe(
      "Hermes skills are unavailable for this provider.",
    );
  });
});

describe("skillsNegotiationFooter", () => {
  it("returns no footer when a provider is ready or none are configured", () => {
    expect(skillsNegotiationFooter([])).toBeNull();
    expect(
      skillsNegotiationFooter([
        provider({ status: "ready" }),
        provider({ status: "error", protocolClassification: null }),
      ]),
    ).toBeNull();
  });

  it("shows the footer only for capability-blocked gateways", () => {
    expect(
      skillsNegotiationFooter([
        provider({ status: "unavailable", protocolClassification: "legacy" }),
      ]),
    ).toBe("Skills access requires a gateway with a negotiated skills.manage capability.");
  });

  it("stays silent for unreachable or misconfigured providers", () => {
    expect(
      skillsNegotiationFooter([
        provider({ status: "error", protocolClassification: null }),
        provider({ status: "unavailable", protocolClassification: null }),
      ]),
    ).toBeNull();
  });
});
