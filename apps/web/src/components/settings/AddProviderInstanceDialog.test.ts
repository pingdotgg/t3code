import { describe, expect, it } from "vite-plus/test";

import {
  getProviderIdentityDraft,
  resolveAcpRegistryWizardNavigation,
  resolveWizardNavigation,
  updateProviderIdentityDraft,
} from "./AddProviderInstanceDialog.logic";

describe("resolveWizardNavigation", () => {
  const invalidId = { instanceIdError: "Instance ID is required." };

  // regression: #2813 the wizard advanced past an invalid instance id
  it("blocks Next from Identity to Config while the instance id is invalid", () => {
    expect(resolveWizardNavigation(1, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("stops a direct Driver-to-Config skip at Identity and surfaces its error", () => {
    expect(resolveWizardNavigation(0, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });
});

describe("ACP Registry wizard", () => {
  it("requires a prepared result or valid manual configuration before Identity", () => {
    expect(
      resolveAcpRegistryWizardNavigation(0, 1, {
        instanceIdError: null,
        selectionError: "Select an ACP or configure one manually.",
      }),
    ).toEqual({
      kind: "blocked",
      step: 0,
      error: "Select an ACP or configure one manually.",
    });

    expect(
      resolveAcpRegistryWizardNavigation(0, 1, {
        instanceIdError: null,
        selectionError: null,
      }),
    ).toEqual({ kind: "navigate", step: 1 });
  });

  it("keeps registry-prefilled identity separate from other drivers", () => {
    const registryDrafts = updateProviderIdentityDraft({}, "acpRegistry", {
      label: "Gemini CLI",
      instanceIdOverride: "acpRegistry_gemini_cli",
    });

    expect(getProviderIdentityDraft(registryDrafts, "codex")).toEqual({
      label: "",
      accentColor: "",
      instanceIdOverride: null,
    });

    const drafts = updateProviderIdentityDraft(registryDrafts, "codex", {
      label: "Work",
      instanceIdOverride: "codex_work",
    });
    expect(getProviderIdentityDraft(drafts, "acpRegistry")).toMatchObject({
      label: "Gemini CLI",
      instanceIdOverride: "acpRegistry_gemini_cli",
    });
  });
});
