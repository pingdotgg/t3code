import { assert, it } from "@effect/vitest";

import { beginAcpMockPrompt } from "./acpMockCancellationState.ts";

it("does not carry an idle cancellation into the next prompt", () => {
  const cancelledSessions = new Set(["session:cancelled-while-idle", "session:other"]);

  beginAcpMockPrompt(cancelledSessions, "session:cancelled-while-idle");

  assert.isFalse(cancelledSessions.has("session:cancelled-while-idle"));
  assert.isTrue(cancelledSessions.has("session:other"));
});
