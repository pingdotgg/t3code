import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { codexAuthDeliveryUrl } from "@t3tools/shared/codexAuthHandoff";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  prepareProviderAuthDelivery,
  pendingProviderAuthDelivery,
  clearProviderAuthDelivery,
} from "./providerAuthDelivery";

afterEach(() => {
  clearProviderAuthDelivery();
  vi.unstubAllGlobals();
});

describe("hosted provider callback bootstrap", () => {
  it("restores the welcome step and removes the code before router initialization", () => {
    const authorizationUrl = new URL("https://auth.openai.com/api/accounts/authorize");
    authorizationUrl.search = new URLSearchParams({
      client_id: "dynamic_agent_client",
      response_type: "code",
      redirect_uri: "http://127.0.0.1:54213/auth/callback",
      state: "a".repeat(43),
      code_challenge_method: "S256",
      code_challenge: "b".repeat(43),
    }).toString();
    const input = {
      authorizationUrl: authorizationUrl.toString(),
      returnUrl: "https://app.t3.codes/welcome#agents:remote-environment",
      environmentId: EnvironmentId.make("remote-environment"),
      instanceId: ProviderInstanceId.make("work"),
      flowId: "flow-one",
    };
    const callbackUrl = `http://127.0.0.1:54213/auth/callback?state=${"a".repeat(43)}&code=test-code&client_id=oaiapp_test`;
    const href = codexAuthDeliveryUrl(input, callbackUrl);
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: new URL(href),
      history: { state: { navigation: 1 }, replaceState },
    });
    prepareProviderAuthDelivery();
    expect(replaceState).toHaveBeenCalledWith({ navigation: 1 }, "", input.returnUrl);
    expect(pendingProviderAuthDelivery()?.callbackUrl).toBe(callbackUrl);
    expect(pendingProviderAuthDelivery()?.environmentId).toBe(input.environmentId);
  });
  it("also removes malformed callback fragments", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: new URL("https://app.t3.codes/settings/providers#codex-auth=invalid-code"),
      history: { state: null, replaceState },
    });
    prepareProviderAuthDelivery();
    expect(pendingProviderAuthDelivery()).toBeUndefined();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/settings/providers");
  });
});
