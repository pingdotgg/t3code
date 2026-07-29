import { describe, expect, it } from "vite-plus/test";

import { resolveClerkAuthRedirectUrl } from "./authRedirect";

describe("resolveClerkAuthRedirectUrl", () => {
  it("preserves the current browser URL", () => {
    const href = "https://app.t3.codes/connect?state=state-1#details";
    expect(resolveClerkAuthRedirectUrl(href, false)).toBe(href);
  });

  it("uses the allowlisted packaged desktop callback", () => {
    expect(resolveClerkAuthRedirectUrl("t3code://app/continue#/settings/general", true)).toBe(
      "t3code://app/",
    );
  });

  it("uses the allowlisted development desktop callback", () => {
    expect(resolveClerkAuthRedirectUrl("t3code-dev://app/continue#/settings/general", true)).toBe(
      "t3code-dev://app/",
    );
  });
});
