import type { ProviderAuthState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { settleAuthorizationPage, settleHandoffAuthorizationPage } from "./CodexSetupSection.logic";

const auth = (overrides: Partial<ProviderAuthState>) =>
  ({
    instanceId: "codex",
    phase: "starting",
    flowId: "flow-1",
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    ...overrides,
  }) as ProviderAuthState;

describe("settleAuthorizationPage", () => {
  it("waits for its own flow to reach the browser step", () => {
    expect(settleAuthorizationPage(null, "flow-1")).toBeUndefined();
    expect(settleAuthorizationPage(auth({ phase: "starting" }), "flow-1")).toBeUndefined();
    expect(
      settleAuthorizationPage(auth({ phase: "waiting", authorizationUrl: "https://a" }), "flow-1"),
    ).toBe("https://a");
    expect(
      settleAuthorizationPage(
        auth({
          phase: "waiting",
          authorizationUrl: "https://a",
          interaction: {
            type: "browser",
            id: "interaction-1",
            url: "https://b",
            requiresConsent: false,
          } as ProviderAuthState["interaction"],
        }),
        "flow-1",
      ),
    ).toBe("https://b");
  });

  it("ignores a flow another client started", () => {
    expect(
      settleAuthorizationPage(
        auth({ flowId: "flow-2", phase: "waiting", authorizationUrl: "https://a" }),
        "flow-1",
      ),
    ).toBeUndefined();
  });

  it("gives up when its flow ends before a page is available", () => {
    expect(settleAuthorizationPage(auth({ phase: "failed" }), "flow-1")).toBeNull();
    expect(settleAuthorizationPage(auth({ phase: "cancelled" }), "flow-1")).toBeNull();
    expect(settleAuthorizationPage(auth({ phase: "succeeded" }), "flow-1")).toBeNull();
  });

  it("follows a handoff until the primary environment finishes", () => {
    expect(
      settleHandoffAuthorizationPage({
        phase: "auth",
        state: auth({ flowId: "primary-flow", phase: "waiting", authorizationUrl: "https://a" }),
      }),
    ).toBe("https://a");
    expect(settleHandoffAuthorizationPage({ phase: "finished", profile: {} as never })).toBeNull();
  });
});
