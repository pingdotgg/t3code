import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["kbcode", "kbcode-dev", "t3code", "t3code-dev"])(
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
    "kbcode://attacker/welcome",
    "t3code://attacker/welcome",
    "t3code://app/welcome/../evil",
    "https://attacker.example/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());

  it("accepts self-hosted web origin configured via HOSTED_APP_URL", () => {
    const previous = process.env.HOSTED_APP_URL;
    process.env.HOSTED_APP_URL = "https://app.kbcode.dev";
    try {
      expect(
        providerAuthReturnUrl("https://app.kbcode.dev/settings/providers?instanceId=work"),
      ).toBe("https://app.kbcode.dev/settings/providers?instanceId=work");
    } finally {
      if (previous === undefined) {
        delete process.env.HOSTED_APP_URL;
      } else {
        process.env.HOSTED_APP_URL = previous;
      }
    }
  });
});
