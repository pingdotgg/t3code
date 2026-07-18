import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { causeFailureMessage } from "./causeMessage.ts";

describe("causeFailureMessage", () => {
  it("returns the message of an Error failure", () => {
    expect(causeFailureMessage(Cause.fail(new Error("boom")), "fallback")).toBe("boom");
  });

  it("returns a string failure verbatim", () => {
    expect(causeFailureMessage(Cause.fail("nope"), "fallback")).toBe("nope");
  });

  it("returns the message of a tagged error object", () => {
    expect(
      causeFailureMessage(
        Cause.fail({ _tag: "RelayInternalError", message: "relay down" }),
        "fallback",
      ),
    ).toBe("relay down");
  });

  it("falls back for empty Error messages", () => {
    expect(causeFailureMessage(Cause.fail(new Error("   ")), "fallback")).toBe("fallback");
  });

  it("falls back for empty string failures", () => {
    expect(causeFailureMessage(Cause.fail(""), "fallback")).toBe("fallback");
  });

  it("falls back for objects without a string message", () => {
    expect(causeFailureMessage(Cause.fail({ code: 500 }), "fallback")).toBe("fallback");
    expect(causeFailureMessage(Cause.fail({ message: 42 }), "fallback")).toBe("fallback");
  });

  it("falls back for other primitive failures", () => {
    expect(causeFailureMessage(Cause.fail(null), "fallback")).toBe("fallback");
    expect(causeFailureMessage(Cause.fail(42), "fallback")).toBe("fallback");
  });

  it("returns the defect message for die causes", () => {
    expect(causeFailureMessage(Cause.die(new Error("defect")), "fallback")).toBe("defect");
  });
});
