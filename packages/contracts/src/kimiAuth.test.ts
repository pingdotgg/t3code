import { expect, it } from "@effect/vitest";

import { KimiAuthError } from "./kimiAuth.ts";

it("preserves the underlying cause separately from stable context", () => {
  const cause = new Error("sensitive transport detail");
  const error = new KimiAuthError({
    reason: "request-failed",
    detail: "Failed to request Kimi device authorization.",
    cause,
  });

  expect(error.detail).toBe("Failed to request Kimi device authorization.");
  expect(error.cause).toBe(cause);
  expect(error.message).toBe("Kimi sign-in failed.");
});
