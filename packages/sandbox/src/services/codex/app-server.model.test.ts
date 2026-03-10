import { describe, expect, test } from "bun:test";

import { DEFAULT_CODEX_MODEL, resolveCodexModel } from "./app-server.model";

describe("resolveCodexModel", () => {
  test("falls back to the sandbox default when no model is provided", () => {
    expect(resolveCodexModel()).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveCodexModel(null)).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveCodexModel("")).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveCodexModel("   ")).toBe(DEFAULT_CODEX_MODEL);
  });

  test("preserves explicit model overrides", () => {
    expect(resolveCodexModel("gpt-5.4")).toBe("gpt-5.4");
    expect(resolveCodexModel("gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });
});
