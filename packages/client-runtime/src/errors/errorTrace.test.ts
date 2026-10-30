import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { findErrorTraceId } from "./errorTrace.ts";

describe("findErrorTraceId", () => {
  it("terminates for cyclic causes", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;

    expect(findErrorTraceId(error)).toBeNull();
  });

  it("finds trace metadata in Effect cause branches", () => {
    const cause = Cause.fromReasons<unknown>([
      Cause.makeFailReason(new Error("first failure")),
      Cause.makeFailReason({ traceId: "trace-secondary" }),
    ]);

    expect(findErrorTraceId(cause)).toBe("trace-secondary");
  });
});
