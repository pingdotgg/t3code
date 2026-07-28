import { describe, expect, it } from "vite-plus/test";

import { presentProviderError } from "./providerErrorPresentation";

describe("presentProviderError", () => {
  it("turns Hermes attachment configuration failures into a next step", () => {
    expect(
      presentProviderError(
        "hermes provider protocol error: Attachments are disabled for this Hermes instance.",
      ),
    ).toBe(
      "Hermes attachments are turned off. Enable Attachments in Settings → Providers, then try again.",
    );
  });

  it("explains unsupported gateway attachment capabilities without adapter jargon", () => {
    expect(
      presentProviderError(
        "ProviderAdapterProtocolError: hermes provider protocol error: This Hermes gateway does not support PDF attachments.",
      ),
    ).toBe(
      "This Hermes gateway does not support pdf attachments. Remove the pdf attachment or update the gateway, then try again.",
    );
  });

  it("removes internal run and provider-thread ids from turn-start failures", () => {
    expect(
      presentProviderError(
        "Failed to start run run-secret on hermes provider thread provider-thread-secret.",
      ),
    ).toBe(
      "Hermes couldn't start this message. Check the provider connection in Settings → Providers, then try again.",
    );
  });

  it("leaves already-polished errors unchanged", () => {
    expect(presentProviderError("Could not connect to the provider after repeated attempts.")).toBe(
      "Could not connect to the provider after repeated attempts.",
    );
  });
});
