import * as Cause from "effect/Cause";
import { expect, it } from "vite-plus/test";

import { formatEnvironmentQueryError } from "./query";

it("preserves server defects serialized as strings", () => {
  const message = 'Expected "local" | "worktree"\n  at ["mode"]';
  expect(formatEnvironmentQueryError(Cause.die(message))).toBe(message);
});

it("keeps Error messages and falls back for empty or unknown failures", () => {
  expect(formatEnvironmentQueryError(Cause.fail(new Error("Save failed")))).toBe("Save failed");
  for (const failure of [" ", {}, null]) {
    expect(formatEnvironmentQueryError(Cause.fail(failure))).toBe(
      "The environment request failed.",
    );
  }
});
