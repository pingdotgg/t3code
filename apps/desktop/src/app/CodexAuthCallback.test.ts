// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Tests exercise the real native loopback listener without an OpenAI account.
import * as NodeHttp from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { codexAuthDeliveryUrl, readCodexAuthDelivery } from "@t3tools/shared/codexAuthHandoff";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { receiveCodexAuthCallback, cancelCodexAuthCallback } from "./CodexAuthCallback.ts";

async function freePort() {
  const server = NodeHttp.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
function request(port: number, state = "a".repeat(43)) {
  const url = new URL("https://auth.openai.com/api/accounts/authorize");
  url.search = new URLSearchParams({
    client_id: "dynamic_agent_client",
    response_type: "code",
    redirect_uri: `http://127.0.0.1:${port}/auth/callback`,
    state,
    code_challenge_method: "S256",
    code_challenge: "b".repeat(43),
  }).toString();
  return url.toString();
}
function callback(authorizationUrl: string) {
  const request = new URL(authorizationUrl);
  const url = new URL(request.searchParams.get("redirect_uri")!);
  url.search = new URLSearchParams({
    state: request.searchParams.get("state")!,
    code: "test-code",
    client_id: "oaiapp_test",
  }).toString();
  return url.toString();
}

describe("desktop Codex callback helper", () => {
  it("binds before opening sign-in, ignores a foreign response, and returns only the code callback", async () => {
    const authorizationUrl = request(await freePort());
    const expected = callback(authorizationUrl);
    const received = await receiveCodexAuthCallback(authorizationUrl, async () => {
      const invalid = new URL(expected);
      invalid.searchParams.set("state", "foreign");
      expect((await fetch(invalid)).status).toBe(400);
      const response = await fetch(expected);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("test-code");
      return true;
    });
    expect(received).toBe(expected);
  });
  it("returns hosted web to the exact instance and environment without putting the code in its query", async () => {
    const authorizationUrl = request(await freePort());
    const expected = callback(authorizationUrl);
    const input = {
      authorizationUrl,
      returnUrl: "https://app.t3.codes/settings/providers?environmentId=remote-one&instanceId=work",
      environmentId: EnvironmentId.make("remote-one"),
      instanceId: ProviderInstanceId.make("work"),
      flowId: "flow-one",
    };
    await receiveCodexAuthCallback(
      authorizationUrl,
      async () => {
        const response = await fetch(expected, { redirect: "manual" });
        expect(response.status).toBe(303);
        const delivery = response.headers.get("location")!;
        expect(new URL(delivery).searchParams.has("code")).toBe(false);
        expect(readCodexAuthDelivery(delivery)?.callbackUrl).toBe(expected);
        expect(readCodexAuthDelivery(delivery)?.returnUrl).toBe(input.returnUrl);
        return true;
      },
      (url) => codexAuthDeliveryUrl(input, url),
    );
  });
  it("cancels and releases its listener so exact-port reauthorization can run again", async () => {
    const authorizationUrl = request(await freePort());
    await expect(
      receiveCodexAuthCallback(authorizationUrl, async () => {
        cancelCodexAuthCallback(authorizationUrl);
        return true;
      }),
    ).rejects.toThrow("cancelled");
    expect(
      await receiveCodexAuthCallback(authorizationUrl, async () => {
        await fetch(callback(authorizationUrl));
        return true;
      }),
    ).toBe(callback(authorizationUrl));
  });
  it("allows two accounts to complete independently", async () => {
    const a = request(await freePort(), "a".repeat(43));
    const b = request(await freePort(), "c".repeat(43));
    const openedA = Promise.withResolvers<void>();
    const openedB = Promise.withResolvers<void>();
    const receiveA = receiveCodexAuthCallback(a, async () => {
      openedA.resolve();
      await openedB.promise;
      await fetch(callback(a));
      return true;
    });
    const receiveB = receiveCodexAuthCallback(b, async () => {
      openedB.resolve();
      await openedA.promise;
      await fetch(callback(b));
      return true;
    });
    expect(await Promise.all([receiveA, receiveB])).toEqual([callback(a), callback(b)]);
  });
});
