import * as NodeAssert from "node:assert/strict";

import * as Cause from "effect/Cause";
import { describe, it } from "vite-plus/test";

import { OpenCodeRuntimeError, openCodeRuntimeErrorDetail } from "./opencodeRuntime.ts";

describe("openCodeRuntimeErrorDetail", () => {
  it("formats an Effect TimeoutError constructed without a message", () => {
    const detail = openCodeRuntimeErrorDetail(new Cause.TimeoutError());
    NodeAssert.equal(typeof detail, "string");
    NodeAssert.match(detail, /TimeoutError/);
  });

  it("returns the detail of an OpenCodeRuntimeError", () => {
    const error = new OpenCodeRuntimeError({ operation: "session.abort", detail: "aborted" });
    NodeAssert.equal(openCodeRuntimeErrorDetail(error), "aborted");
  });

  it("returns a trimmed Error message", () => {
    NodeAssert.equal(openCodeRuntimeErrorDetail(new Error("  timed out  ")), "timed out");
  });

  it("does not throw for an Error whose message is undefined", () => {
    // Effect's TimeoutError constructed without an argument arrives this way.
    const error = new Error("placeholder");
    Object.defineProperty(error, "message", { value: undefined, writable: true });
    const detail = openCodeRuntimeErrorDetail(error);
    NodeAssert.equal(typeof detail, "string");
    NodeAssert.ok(detail.length > 0);
  });

  it("does not throw for an Error whose message is not a string", () => {
    const error = new Error("placeholder");
    Object.defineProperty(error, "message", { value: { code: 42 }, writable: true });
    const detail = openCodeRuntimeErrorDetail(error);
    NodeAssert.equal(typeof detail, "string");
    NodeAssert.ok(detail.length > 0);
  });

  it("falls through to the object fallback for an Error with an empty message", () => {
    const error = Object.assign(new Error(""), { response: { status: 503 }, error: "down" });
    NodeAssert.equal(openCodeRuntimeErrorDetail(error), 'status=503 body="down"');
  });

  it("formats SDK response shapes", () => {
    NodeAssert.equal(
      openCodeRuntimeErrorDetail({ response: { status: 500 }, error: { message: "boom" } }),
      'status=500 body={"message":"boom"}',
    );
  });

  it("stringifies primitives", () => {
    NodeAssert.equal(openCodeRuntimeErrorDetail("plain"), "plain");
    NodeAssert.equal(openCodeRuntimeErrorDetail(undefined), "undefined");
  });
});
