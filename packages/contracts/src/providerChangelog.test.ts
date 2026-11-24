import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_CHANGELOG_URLS } from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

const url = (driver: string, version: string) =>
  PROVIDER_CHANGELOG_URLS[ProviderDriverKind.make(driver)]?.(version);

describe("PROVIDER_CHANGELOG_URLS", () => {
  it("links the release being updated to", () => {
    expect(url("codex", "0.172.0")).toBe(
      "https://github.com/openai/codex/releases/tag/rust-v0.172.0",
    );
    expect(url("claudeAgent", "2.1.331")).toBe(
      "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21331",
    );
    expect(url("opencode", "2.4.1")).toBe(
      "https://github.com/anomalyco/opencode/releases/tag/v2.4.1",
    );
  });
});
