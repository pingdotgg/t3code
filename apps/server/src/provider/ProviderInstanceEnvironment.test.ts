import { describe, expect, it } from "vite-plus/test";

import {
  mergeProviderInstanceEnvironment,
  mergeProviderSessionEnvironment,
} from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("strips inherited T3 Code runtime env keys", () => {
    expect(
      mergeProviderInstanceEnvironment(undefined, {
        T3CODE_PORT: "3773",
        T3CODE_HOME: "/tmp/.t3",
        PATH: "/bin",
      }),
    ).toEqual({
      PATH: "/bin",
    });
  });

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
});

describe("mergeProviderSessionEnvironment", () => {
  it("accepts nullable inputs and strips managed runtime env keys from the base env", () => {
    expect(
      mergeProviderSessionEnvironment(
        {
          T3CODE_PORT: "3773",
          T3_MCP_BEARER_TOKEN: "client-token",
          PATH: "/bin",
        },
        null,
      ),
    ).toEqual({
      PATH: "/bin",
    });
  });

  it("overlays resolved session env after filtering the base env", () => {
    expect(
      mergeProviderSessionEnvironment(
        {
          T3_MCP_BEARER_TOKEN: "client-token",
          PATH: "/bin",
        },
        {
          T3_MCP_BEARER_TOKEN: "server-token",
          CUSTOM_FLAG: "1",
        },
      ),
    ).toEqual({
      PATH: "/bin",
      T3_MCP_BEARER_TOKEN: "server-token",
      CUSTOM_FLAG: "1",
    });
  });
});
