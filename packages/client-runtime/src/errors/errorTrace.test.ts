import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { findErrorTraceId } from "./errorTrace.ts";

describe("findErrorTraceId", () => {
  it("finds trace metadata through wrapped typed errors", () => {
    expect(
      findErrorTraceId({
        cause: {
          cause: {
            _tag: "RelayInternalError",
            traceId: "trace-relay",
          },
        },
      }),
    ).toBe("trace-relay");
  });

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

  it("finds trace metadata in aggregate error branches", () => {
    const error = new AggregateError(
      [new Error("first failure"), { traceId: "trace-aggregate" }],
      "request failed",
    );

    expect(findErrorTraceId(error)).toBe("trace-aggregate");
  });
});
