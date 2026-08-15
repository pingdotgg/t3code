import { expect, it } from "@effect/vitest";

import { isCodexNativeCommandPath } from "./CodexDriver.ts";

it("treats codex standalone installs as native-updatable", () => {
  expect(isCodexNativeCommandPath("/Users/example/.local/bin/codex")).toBe(true);
  expect(
    isCodexNativeCommandPath(
      "/Users/example/.codex/packages/standalone/releases/0.146.1-aarch64-apple-darwin/bin/codex",
    ),
  ).toBe(true);
  expect(isCodexNativeCommandPath("C:\\Users\\example\\.local\\bin\\codex.exe")).toBe(true);
});

it("leaves package-manager-owned codex installs to their package manager", () => {
  expect(
    isCodexNativeCommandPath("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"),
  ).toBe(false);
  expect(isCodexNativeCommandPath("/Users/example/.bun/bin/codex")).toBe(false);
  expect(isCodexNativeCommandPath("/opt/homebrew/Cellar/codex/0.147.0/bin/codex")).toBe(false);
});
