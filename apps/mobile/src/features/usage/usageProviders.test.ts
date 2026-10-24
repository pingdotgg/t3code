import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_LABEL, PROVIDER_ORDER, usageProviderKind } from "./usageProviderPresentation";

describe("usage provider presentation", () => {
  it("maps the ACP Registry driver to the Mistral Vibe provider", () => {
    expect(usageProviderKind("acpRegistry")).toBe("mistral");
  });

  it("labels and orders Mistral Vibe as a usage provider", () => {
    expect(PROVIDER_LABEL.mistral).toBe("Mistral Vibe");
    expect(PROVIDER_ORDER).toContain("mistral");
  });

  it("keeps a label for every ordered provider", () => {
    for (const provider of PROVIDER_ORDER) {
      expect(PROVIDER_LABEL[provider]).toBeTruthy();
    }
  });
});
