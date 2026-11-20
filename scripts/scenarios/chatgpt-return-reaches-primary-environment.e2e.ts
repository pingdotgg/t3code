import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { codexAuthDeliveryUrl } from "@t3tools/shared/codexAuthHandoff";
import { expect } from "e2e";

import { environmentId, runPromise, test, WEB } from "./t3.ts";

test(
  "A ChatGPT sign-in return reaches the primary environment after a failed discovery request",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const primaryId = EnvironmentId.make(await runPromise(environmentId(app.baseUrl)));
    const state = "scenario-auth-state";
    const redirectUri = "http://127.0.0.1:1455/auth/callback";
    const authorization = new URL("https://auth.openai.com/api/accounts/authorize");
    authorization.search = new URLSearchParams({
      state,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: "a".repeat(43),
      client_id: "dynamic_agent_client",
    }).toString();
    const callback = new URL(redirectUri);
    callback.search = new URLSearchParams({ state, code: "scenario-code" }).toString();
    const returnUrl = new URL("/welcome", app.baseUrl);
    returnUrl.hash = `agents:${primaryId}`;
    const delivery = new URL(
      codexAuthDeliveryUrl(
        {
          authorizationUrl: authorization.href,
          returnUrl: returnUrl.href,
          environmentId: primaryId,
          instanceId: ProviderInstanceId.make("codex"),
          flowId: "scenario-flow",
        },
        callback.href,
      ),
    );

    await t3.open();
    let firstDescriptorAborted = false;
    await browser.route("**/.well-known/t3/environment", async (route) => {
      if (firstDescriptorAborted) {
        await route.fallback();
        return;
      }
      firstDescriptorAborted = true;
      await route.abort();
    });
    await app.open(`${delivery.pathname}${delivery.search}${delivery.hash}`);
    // The server rejects the fake flow before any request to the identity provider.
    await expect(
      screen.getByText("Return to the provider and try again.", { exact: true }),
    ).toBeVisible();
    expect(firstDescriptorAborted).toBe(true);
  },
);
