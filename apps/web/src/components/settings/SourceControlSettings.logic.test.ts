import { describe, expect, it } from "vite-plus/test";

import { formattedAuthSuffix, formattedSetupGuidance } from "./SourceControlSettings.logic";

describe("formattedAuthSuffix", () => {
  it("returns empty string when host and detail are null", () => {
    expect(formattedAuthSuffix(null, null)).toBe("");
  });

  it("returns host segment when host is present", () => {
    expect(formattedAuthSuffix("git.example.com", null)).toBe(" on git.example.com");
  });

  it("returns detail segment when detail is present", () => {
    expect(formattedAuthSuffix(null, "2 Gitea instances configured")).toBe(
      " \u2014 2 Gitea instances configured",
    );
  });

  it("returns host and detail segments when both are present", () => {
    expect(formattedAuthSuffix("git.example.com", "2 Gitea instances configured")).toBe(
      " on git.example.com \u2014 2 Gitea instances configured",
    );
  });
});

describe("formattedSetupGuidance", () => {
  it("returns provider-neutral guidance before the executable chip", () => {
    expect(formattedSetupGuidance("Gitea")).toBe(
      "Gitea is not authenticated on this server. Sign in or configure credentials using the",
    );
  });

  it("uses the same neutral guidance for other CLI providers", () => {
    expect(formattedSetupGuidance("GitHub")).toBe(
      "GitHub is not authenticated on this server. Sign in or configure credentials using the",
    );
  });
});
