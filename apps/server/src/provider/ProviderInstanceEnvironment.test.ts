import { describe, expect, it } from "vite-plus/test";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });

  it("applies global variables before provider-scoped overrides", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [{ name: "SHARED_KEY", value: "provider", sensitive: true }],
        { PATH: "/bin" },
        [
          { name: "SHARED_KEY", value: "global", sensitive: true },
          { name: "GLOBAL_ONLY", value: "1", sensitive: false },
        ],
      ),
    ).toMatchObject({
      PATH: "/bin",
      SHARED_KEY: "provider",
      GLOBAL_ONLY: "1",
    });
  });
});
