import assert from "node:assert/strict";

import { it } from "@effect/vitest";

import { normalizeShellPathOutput } from "./shellPath";

it("normalizes colon-delimited shell PATH output", () => {
  assert.strictEqual(
    normalizeShellPathOutput("/usr/local/bin:/opt/homebrew/bin:/usr/bin"),
    "/usr/local/bin:/opt/homebrew/bin:/usr/bin",
  );
});

it("normalizes fish-style whitespace-delimited PATH output", () => {
  assert.strictEqual(
    normalizeShellPathOutput("/usr/local/bin /opt/homebrew/bin /usr/bin"),
    "/usr/local/bin:/opt/homebrew/bin:/usr/bin",
  );
});

it("strips ANSI control sequences from shell PATH output", () => {
  assert.strictEqual(
    normalizeShellPathOutput("\u001b[6 q/usr/local/bin:/opt/homebrew/bin\u001b[2 q"),
    "/usr/local/bin:/opt/homebrew/bin",
  );
});
