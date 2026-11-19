import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

describe("toOpenCodePermissionReply", () => {
  it.each([
    ["accept", "once"],
    ["acceptForSession", "always"],
    ["decline", "reject"],
  ] as const)("maps %s to %s", (decision, reply) => {
    NodeAssert.equal(OpenCodeRuntime.toOpenCodePermissionReply(decision), reply);
  });
});
