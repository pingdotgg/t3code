import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  registerAutoApprovePermissionHandler,
  selectAutoApprovedPermissionOption,
} from "./AcpPermissionAutoApprove.ts";

type PermissionHandler = (
  request: EffectAcpSchema.RequestPermissionRequest,
) => Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError>;

function makeRequest(
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    toolCall: { toolCallId: "tool-call-1" },
    options,
  };
}

const capturePermissionHandler = Effect.gen(function* () {
  let handler: PermissionHandler | undefined;
  yield* registerAutoApprovePermissionHandler({
    handleRequestPermission: (next) => {
      handler = next;
      return Effect.void;
    },
  });
  if (!handler) {
    return yield* Effect.die(new Error("permission handler was not registered"));
  }
  return handler;
});

describe("selectAutoApprovedPermissionOption", () => {
  it("prefers allow_always over allow_once", () => {
    const optionId = selectAutoApprovedPermissionOption(
      makeRequest([
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ]),
    );

    expect(optionId).toBe("allow-always");
  });

  it("falls back to allow_once when no allow_always option exists", () => {
    const optionId = selectAutoApprovedPermissionOption(
      makeRequest([
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ]),
    );

    expect(optionId).toBe("allow-once");
  });

  it("skips blank option ids", () => {
    const optionId = selectAutoApprovedPermissionOption(
      makeRequest([
        { optionId: "  ", name: "Allow always", kind: "allow_always" },
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      ]),
    );

    expect(optionId).toBe("allow-once");
  });

  it("returns undefined when no allow option exists", () => {
    const optionId = selectAutoApprovedPermissionOption(
      makeRequest([{ optionId: "reject-once", name: "Reject", kind: "reject_once" }]),
    );

    expect(optionId).toBeUndefined();
  });
});

describe("registerAutoApprovePermissionHandler", () => {
  it.effect("responds with the selected allow option", () =>
    Effect.gen(function* () {
      const handler = yield* capturePermissionHandler;
      const response = yield* handler(
        makeRequest([
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
        ]),
      );

      expect(response).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
    }),
  );

  it.effect("cancels the request when the agent offers no allow option", () =>
    Effect.gen(function* () {
      const handler = yield* capturePermissionHandler;
      const response = yield* handler(
        makeRequest([{ optionId: "reject-once", name: "Reject", kind: "reject_once" }]),
      );

      expect(response).toEqual({ outcome: { outcome: "cancelled" } });
    }),
  );
});
