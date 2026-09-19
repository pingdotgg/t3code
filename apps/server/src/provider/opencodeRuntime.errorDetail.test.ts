import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { openCodeRuntimeErrorDetail } from "./opencodeRuntime.ts";

describe("openCodeRuntimeErrorDetail", () => {
  it("returns the message of a normal Error", () => {
    NodeAssert.equal(openCodeRuntimeErrorDetail(new Error("boom")), "boom");
  });

  it("does not throw when an Error has an undefined message", () => {
    const cause = new Error();
    Object.defineProperty(cause, "message", { value: undefined });
    NodeAssert.equal(openCodeRuntimeErrorDetail(cause), String(cause));
  });
});
