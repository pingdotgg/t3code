import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["tix", "tix-dev"])(
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
    "tix://attacker/welcome",
    "tix://app/welcome/../evil",
    "https://attacker.example/welcome",
    "https://app.t3.codes/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());

  it("allows tailnet web return destinations", () => {
    expect(
      providerAuthReturnUrl("https://my-mac.tailnet.ts.net/welcome?code=secret#agents:m1"),
    ).toBe("https://my-mac.tailnet.ts.net/welcome#agents:m1");
  });
});
