import { assert, describe, it } from "@effect/vitest";

import { providerIconKind, providerIconPalette } from "./providerIconKind";

describe("providerIconKind", () => {
  it("keeps both OpenCode generations distinct", () => {
    assert.strictEqual(providerIconKind("opencode"), "opencode");
    assert.strictEqual(providerIconKind("opencode2"), "opencode2");
  });

  it("preserves existing provider fallbacks", () => {
    assert.strictEqual(providerIconKind("claudeAgent"), "claude");
    assert.strictEqual(providerIconKind("codex"), "openai");
    assert.strictEqual(providerIconKind(undefined), "openai");
  });
});

describe("providerIconPalette", () => {
  it("keeps both OpenCode outer frames contrasted with the application theme", () => {
    assert.strictEqual(providerIconPalette("opencode", false), "light");
    assert.strictEqual(providerIconPalette("opencode", true), "dark");
    assert.strictEqual(providerIconPalette("opencode2", false), "light");
    assert.strictEqual(providerIconPalette("opencode2", true), "dark");
  });
});
