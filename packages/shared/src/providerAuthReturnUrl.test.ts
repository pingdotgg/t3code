import { describe, expect, it } from "vite-plus/test";
import { providerAuthRedirectShowsCode, providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["t3code", "t3code-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it.each([
    "t3code://attacker/welcome",
    "t3code://app/welcome/../evil",
    "https://attacker.example/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());

  it("returns to the build's hosted app and no other", () => {
    const fork = "https://t3.fork.example";
    expect(providerAuthReturnUrl("https://app.t3.codes/settings")).toBe(
      "https://app.t3.codes/settings",
    );
    expect(providerAuthReturnUrl(`${fork}/settings`, fork)).toBe(`${fork}/settings`);
    expect(providerAuthReturnUrl("https://app.t3.codes/settings", fork)).toBeUndefined();
    expect(providerAuthReturnUrl("https://app.t3.codes/settings", "")).toBeUndefined();
  });

  it("returns to a fork's own desktop scheme and not T3 Code's", () => {
    const hosted = "https://app.t3.codes";
    for (const scheme of ["easydevcode", "easydevcode-dev"]) {
      expect(providerAuthReturnUrl(`${scheme}://app/settings`, hosted, "easydevcode")).toBe(
        `${scheme}://app/settings`,
      );
    }
    expect(providerAuthReturnUrl("t3code://app/settings", hosted, "easydevcode")).toBeUndefined();
    expect(
      providerAuthReturnUrl("https://evil.example/settings", hosted, "easydevcode"),
    ).toBeUndefined();
  });

  it("knows when sign-in ends on a page that shows a code", () => {
    const signIn = (redirect: string) =>
      `https://accounts.google.com/o/oauth2/auth?redirect_uri=${encodeURIComponent(redirect)}`;
    expect(providerAuthRedirectShowsCode(signIn("https://antigravity.google/oauth-callback"))).toBe(
      true,
    );
    expect(providerAuthRedirectShowsCode(signIn("http://127.0.0.1:4321/"))).toBe(false);
    expect(providerAuthRedirectShowsCode(signIn("http://localhost:1455/auth/callback"))).toBe(
      false,
    );
    expect(providerAuthRedirectShowsCode("https://accounts.google.com/o/oauth2/auth")).toBe(false);
    expect(providerAuthRedirectShowsCode("not a url")).toBe(false);
  });
});
