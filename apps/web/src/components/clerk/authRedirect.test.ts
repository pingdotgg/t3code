import { describe, expect, it } from "vite-plus/test";

import { resolveClerkSignInProps } from "./authRedirect";

describe("resolveClerkSignInProps", () => {
  it("returns to the current browser URL on the web", () => {
    const href = "https://app.t3.codes/connect?state=state-1#details";
    expect(resolveClerkSignInProps(href, false)).toEqual({ forceRedirectUrl: href });
  });

  it("returns packaged desktop auth flows to the renderer root", () => {
    expect(resolveClerkSignInProps("t3code://app/#/settings/archived", true)).toEqual({
      forceRedirectUrl: "t3code://app/",
      signUpForceRedirectUrl: "t3code://app/",
    });
  });

  it("returns development desktop auth flows to the renderer root", () => {
    expect(resolveClerkSignInProps("t3code-dev://app/#/settings/general", true)).toEqual({
      forceRedirectUrl: "t3code-dev://app/",
      signUpForceRedirectUrl: "t3code-dev://app/",
    });
  });
});
