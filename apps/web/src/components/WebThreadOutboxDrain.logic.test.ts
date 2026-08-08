import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { shouldPauseWebThreadOutboxDelivery } from "./WebThreadOutboxDrain.logic";

describe("shouldPauseWebThreadOutboxDelivery", () => {
  it("defers interrupted commands so reconnect can retry them", () => {
    expect(shouldPauseWebThreadOutboxDelivery(AsyncResult.failure(Cause.interrupt(1)))).toBe(false);
  });

  it("pauses definitive command failures", () => {
    expect(
      shouldPauseWebThreadOutboxDelivery(
        AsyncResult.failure(Cause.fail(new Error("provider rejected the turn"))),
      ),
    ).toBe(true);
  });

  it("does not pause successful commands", () => {
    expect(shouldPauseWebThreadOutboxDelivery(AsyncResult.success(undefined))).toBe(false);
  });
});
