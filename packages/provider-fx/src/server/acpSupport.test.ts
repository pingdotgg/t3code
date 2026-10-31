import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

import { fxPermissionDisposition } from "./acpSupport.ts";

const editRequest = {
  sessionId: "fx-session-01",
  toolCall: { toolCallId: "tool-1", kind: "edit", title: "Write notes.md" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("fx permission prompts", () => {
  // In Auto, fx's own review asks only about what it refused itself; T3
  // answering those by its Auto policy would approve exactly what fx escalated.
  it("sends every Auto prompt to the user", () => {
    assert.equal(
      fxPermissionDisposition(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto",
          interactionMode: "default",
          cwd: "/work",
        }),
        editRequest,
      ),
      "ask",
    );
  });

  it("answers Full access prompts itself unless an explicit policy confines them", () => {
    const fullAccess = {
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/work",
    } as const;
    assert.equal(
      fxPermissionDisposition(ProviderAdapterV2RuntimePolicy.make(fullAccess), editRequest),
      "allow",
    );
    // Runs fx's `ask`, so the policy decides what fx asks about.
    assert.equal(
      fxPermissionDisposition(
        ProviderAdapterV2RuntimePolicy.make({ ...fullAccess, approvalPolicy: "on-request" }),
        editRequest,
      ),
      "ask",
    );
  });
});
