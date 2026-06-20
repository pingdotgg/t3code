import { expect, it } from "@effect/vitest";

import { BunPtyOperationUnavailableError } from "./BunPtyAdapter.ts";

it("describes unavailable Bun PTY operations structurally", () => {
  const error = new BunPtyOperationUnavailableError({
    operation: "resize",
    pid: 42,
  });

  expect(error).toMatchObject({
    _tag: "BunPtyOperationUnavailableError",
    operation: "resize",
    pid: 42,
  });
  expect(error.message).toBe("Bun PTY resize is unavailable for process 42.");
});
