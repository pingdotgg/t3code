import { expect, it } from "@effect/vitest";
import { resolveOmpLaunchArgs } from "./mcpInjection.ts";

it.each([
  "--restore",
  "--from-claude",
  "--from-codex",
  "--goal",
  "--alias",
  "--cwd",
  "--resume",
  "--continue",
])("reserves native startup lifecycle argument %s in both forms", (flag) => {
  expect(resolveOmpLaunchArgs(`${flag} /fixture/session.jsonl`).ok).toBe(false);
  expect(resolveOmpLaunchArgs(`${flag}=/fixture/session.jsonl`).ok).toBe(false);
});
