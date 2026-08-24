import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import { resolveMobileThreadInteractionMode } from "./thread-interaction-mode";

const codexInstanceId = ProviderInstanceId.make("codex");
const grokInstanceId = ProviderInstanceId.make("grok");

describe("resolveMobileThreadInteractionMode", () => {
  it("preserves a supported Plan thread while preferences load", () => {
    expect(
      resolveMobileThreadInteractionMode({
        preferenceLoaded: false,
        planModeEnabled: false,
        providers: [{ instanceId: codexInstanceId, showInteractionModeToggle: true }],
        modelSelection: { instanceId: codexInstanceId },
        preferredMode: undefined,
        fallbackMode: "plan",
      }),
    ).toBe("plan");
  });

  it("forces Build after the Plan preference loads disabled", () => {
    expect(
      resolveMobileThreadInteractionMode({
        preferenceLoaded: true,
        planModeEnabled: false,
        providers: [{ instanceId: codexInstanceId, showInteractionModeToggle: true }],
        modelSelection: { instanceId: codexInstanceId },
        preferredMode: "plan",
        fallbackMode: "plan",
      }),
    ).toBe("default");
  });

  it("forces Build when a persisted Grok outbox entry is drained", () => {
    expect(
      resolveMobileThreadInteractionMode({
        preferenceLoaded: false,
        planModeEnabled: false,
        providers: [{ instanceId: grokInstanceId, showInteractionModeToggle: false }],
        modelSelection: { instanceId: grokInstanceId },
        preferredMode: "plan",
        fallbackMode: "plan",
      }),
    ).toBe("default");
  });
});
