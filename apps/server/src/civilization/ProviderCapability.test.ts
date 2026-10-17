import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { civilizationProviderCapability } from "./ProviderCapability.ts";

const capability = (
  driver: string | undefined,
  overrides: Partial<Parameters<typeof civilizationProviderCapability>[0]> = {},
) =>
  civilizationProviderCapability({
    providerInstanceId: ProviderInstanceId.make("provider-test"),
    observedOnly: false,
    ...(driver === undefined ? {} : { driver }),
    ...overrides,
  });

it("keeps the release-one Civilization provider capability truth table explicit", () => {
  assert.deepInclude(capability("codex"), {
    support: "full",
    contextInjection: true,
    keyedContextReplacement: true,
    providerContinuationRefresh: true,
    messaging: true,
  });
  assert.deepInclude(capability("claudeAgent"), {
    support: "full",
    contextInjection: true,
    keyedContextReplacement: false,
    providerContinuationRefresh: false,
    messaging: true,
  });
  assert.deepInclude(capability("cursor"), {
    support: "metadata_only",
    contextInjection: false,
    messaging: false,
  });
  assert.deepInclude(capability("codex", { observedOnly: true }), {
    support: "metadata_only",
    contextInjection: false,
    messaging: false,
  });
  assert.deepInclude(capability(undefined, { available: false }), {
    support: "unsupported",
    contextInjection: false,
    messaging: false,
  });
});
