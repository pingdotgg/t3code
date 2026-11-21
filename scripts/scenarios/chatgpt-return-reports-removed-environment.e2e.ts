import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { codexAuthDeliveryUrl } from "@t3tools/shared/codexAuthHandoff";
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A ChatGPT sign-in return reports that it cannot finish on a removed environment",
  WEB,
  async ({ t3, app, screen }) => {
    await t3.project("demo");
    const environmentId = EnvironmentId.make("removed-sign-in-machine");
    const instanceId = ProviderInstanceId.make("codex");
    const returnUrl = new URL("/welcome", app.baseUrl);
    returnUrl.hash = `agents:${environmentId}`;

    // Start at the helper's return link. The missing machine makes the code unusable,
    // so this does not contact the identity provider.
    const callback = new URL("http://127.0.0.1:1455/auth/callback");
    callback.searchParams.set("state", "scenario-auth-state");
    const authorization = new URL("https://auth.openai.com/api/accounts/authorize");
    authorization.search = new URLSearchParams({
      state: "scenario-auth-state",
      redirect_uri: "http://127.0.0.1:1455/auth/callback",
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: "a".repeat(43),
      client_id: "dynamic_agent_client",
    }).toString();
    callback.searchParams.set("code", "scenario-code");
    const delivery = new URL(
      codexAuthDeliveryUrl(
        {
          authorizationUrl: authorization.href,
          returnUrl: returnUrl.href,
          environmentId,
          instanceId,
          flowId: "scenario-flow",
        },
        callback.href,
      ),
    );
    await t3.open(`${delivery.pathname}${delivery.search}${delivery.hash}`);
    try {
      await expect(
        screen.getByText("ChatGPT sign-in couldn't finish", { exact: true }),
      ).toBeVisible();
    } finally {
      await app.screenshot("return-to-removed-environment");
    }
  },
);
