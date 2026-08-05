import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as EffectAcpErrors from "effect-acp/errors";

import { sessionLoadFailureIsRecoverable } from "./AcpSessionRuntime.ts";

describe("sessionLoadFailureIsRecoverable", () => {
  it("does not recover from the session/load timeout", () => {
    const timeout = new EffectAcpErrors.AcpTransportError({
      operation: "call-rpc",
      method: "session/load",
      detail: "session/load timed out waiting for RPC response or replay idle gap",
      cause: undefined,
    });
    assert.equal(sessionLoadFailureIsRecoverable(Cause.fail(timeout)), false);
  });

  it("recovers from an agent defect", () => {
    assert.equal(sessionLoadFailureIsRecoverable(Cause.die(new Error("Invalid params"))), true);
  });
});
