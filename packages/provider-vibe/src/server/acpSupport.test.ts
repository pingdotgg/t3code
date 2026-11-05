import { assert, describe, it } from "@effect/vitest";
import type { RuntimeMode } from "@t3tools/contracts";
import * as EffectAcpErrors from "effect-acp/errors";

import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

import {
  vibeCustomModelSlugs,
  vibePromptFailure,
  vibeRuntimeModeForSessionMode,
  vibeSessionModeForPolicy,
} from "./acpSupport.ts";

const policy = (runtimeMode: RuntimeMode, overrides: Record<string, unknown> = {}) =>
  ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: "/work",
    ...overrides,
  });

describe("Vibe agents for T3 runtime modes", () => {
  it("runs each runtime mode as its Vibe agent", () => {
    const cases: ReadonlyArray<readonly [RuntimeMode, string, RuntimeMode | undefined]> = [
      ["approval-required", "ask", "approval-required"],
      ["auto-accept-edits", "accept-edits", "auto-accept-edits"],
      ["full-access", "auto-approve", "full-access"],
      ["auto", "ask", "approval-required"],
    ];
    for (const [runtimeMode, agent, granted] of cases) {
      assert.equal(vibeSessionModeForPolicy(policy(runtimeMode)), agent, runtimeMode);
      assert.equal(vibeRuntimeModeForSessionMode(agent), granted, agent);
    }
    assert.isUndefined(vibeRuntimeModeForSessionMode("smart-approve"));
  });

  // Vibe's own permissive agents would approve calls before T3's policy sees them.
  it("keeps an explicit approval or sandbox policy on ask", () => {
    assert.equal(
      vibeSessionModeForPolicy(policy("full-access", { approvalPolicy: "on-request" })),
      "ask",
    );
    assert.equal(
      vibeSessionModeForPolicy(policy("full-access", { sandboxPolicy: { type: "readOnly" } })),
      "ask",
    );
  });
});

describe("vibePromptFailure", () => {
  it("classifies Vibe's rate limit as a usage limit", () => {
    const limit = new EffectAcpErrors.AcpRequestError({
      code: -31001,
      errorMessage: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
    });
    assert.deepEqual(vibePromptFailure(limit), {
      class: "usage_limit",
      message: limit.errorMessage,
      code: "-31001",
      retryable: null,
    });
    assert.equal(
      vibePromptFailure(
        new EffectAcpErrors.AcpRequestError({ code: -32603, errorMessage: "Internal error" }),
      ).class,
      "provider_error",
    );
    assert.equal(vibePromptFailure(new Error("private defect")).message, "Provider turn failed.");
  });
});

describe("vibeCustomModelSlugs", () => {
  // `default` is T3's keep-the-session-model choice, never a model id Vibe knows.
  it("sends custom models to Vibe except the reserved default", () => {
    assert.deepEqual(
      vibeCustomModelSlugs({
        customModels: ["devstral-medium", "default", { slug: "codestral", name: "Codestral" }],
      }),
      ["devstral-medium", "codestral"],
    );
  });
});
