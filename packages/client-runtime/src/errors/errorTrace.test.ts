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
});
