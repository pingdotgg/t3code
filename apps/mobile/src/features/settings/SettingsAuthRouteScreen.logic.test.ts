import { describe, expect, it } from "vite-plus/test";

import { resolveSettingsAuthHeaderOptions } from "./SettingsAuthRouteScreen.logic";

describe("resolveSettingsAuthHeaderOptions", () => {
  it("keeps the native header while Clerk restores the session", () => {
    expect(resolveSettingsAuthHeaderOptions({ isLoaded: false, isSignedIn: undefined })).toEqual({
      headerShown: true,
      title: "Sign in",
    });
  });

  it("lets Clerk own navigation during authentication", () => {
    expect(resolveSettingsAuthHeaderOptions({ isLoaded: true, isSignedIn: false })).toEqual({
      headerShown: false,
      title: "Sign in",
    });
  });

  it("restores the native header for the account screen", () => {
    expect(resolveSettingsAuthHeaderOptions({ isLoaded: true, isSignedIn: true })).toEqual({
      headerShown: true,
      title: "Account",
    });
  });
});
