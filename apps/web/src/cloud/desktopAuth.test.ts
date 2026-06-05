import { describe, expect, it } from "vitest";

import { resolveDesktopCloudAuthOAuthOptions } from "./desktopAuth";

describe("resolveDesktopCloudAuthOAuthOptions", () => {
  it("ignores absent social provider settings", () => {
    expect(
      resolveDesktopCloudAuthOAuthOptions({
        environment: {
          userSettings: {
            social: {
              github: null,
              google: {
                strategy: "oauth_google",
                enabled: true,
                authenticatable: true,
              },
            },
          },
        },
      }),
    ).toEqual([
      {
        strategy: "oauth_google",
        label: "Google",
        providerId: "google",
        iconUrl: null,
      },
    ]);
  });

  it("preserves provider display metadata when Clerk exposes the strategy list", () => {
    expect(
      resolveDesktopCloudAuthOAuthOptions({
        environment: {
          userSettings: {
            authenticatableSocialStrategies: ["oauth_google"],
            social: {
              oauth_google: {
                strategy: "oauth_google",
                enabled: true,
                authenticatable: true,
                name: "Google",
                logo_url: "https://img.clerk.com/static/google.png",
              },
            },
          },
        },
      }),
    ).toEqual([
      {
        strategy: "oauth_google",
        label: "Google",
        providerId: "google",
        iconUrl: "https://img.clerk.com/static/google.png",
      },
    ]);
  });
});
