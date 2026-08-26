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
  it("names tea login add when executable is present", () => {
    expect(formattedSetupGuidance("Gitea", "tea", "Install tea from https://example.com")).toBe(
      "Gitea is not authenticated on this server. Run `tea login add` on the server host to enable change request features.",
    );
  });

  it("falls back to installHint when executable is null", () => {
    expect(
      formattedSetupGuidance("GitHub", null, "Install the GitHub CLI from https://cli.github.com"),
    ).toBe(
      "GitHub is not authenticated on this server. Install the GitHub CLI from https://cli.github.com",
    );
  });
});
