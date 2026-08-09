import { describe, expect, it } from "vite-plus/test";

import { resolveClerkSignInProps } from "./authRedirect";

describe("resolveClerkSignInProps", () => {
  it("returns to the current browser URL on the web", () => {
    const href = "https://app.t3.codes/connect?state=state-1#details";
    expect(resolveClerkSignInProps(href, false)).toEqual({ forceRedirectUrl: href });
  });

  it("returns to the renderer root on packaged desktop", () => {
    expect(
      resolveClerkSignInProps(
        "t3code://app/CLERK-ROUTER/VIRTUAL/sign-up#/settings/connections",
        true,
      ),
    ).toEqual({
      forceRedirectUrl: "t3code://app/",
      signUpForceRedirectUrl: "t3code://app/",
    });
  });

  it("returns to the renderer root on development desktop", () => {
    expect(resolveClerkSignInProps("t3code-dev://app/#/settings/general", true)).toEqual({
      forceRedirectUrl: "t3code-dev://app/",
      signUpForceRedirectUrl: "t3code-dev://app/",
    });
  });
});
