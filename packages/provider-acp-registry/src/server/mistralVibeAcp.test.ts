import { assert, it } from "@effect/vitest";
import type { RuntimeMode } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as EffectAcpSchema from "effect-acp/compat";

import { mistralVibePermissionDisposition, mistralVibeSessionMode } from "./mistralVibeAcp.ts";

const shellRequest: EffectAcpSchema.RequestPermissionRequest = {
  sessionId: "session-1",
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  ],
  toolCall: { toolCallId: "tool-1", title: "bash", kind: "execute" },
};

const policy = (runtimeMode: RuntimeMode, sandboxPolicy?: unknown) =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
    ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
  });

it("hands the user only the calls Smart Approve flags", () => {
  assert.equal(
    mistralVibePermissionDisposition(policy("auto"), shellRequest, "smart-approve"),
    "ask",
  );
  // Without the Smart Approve rollout Vibe runs Ask, and Auto approves as for any agent.
  assert.equal(mistralVibePermissionDisposition(policy("auto"), shellRequest, "ask"), "allow");
  assert.equal(
    mistralVibePermissionDisposition(policy("auto", { type: "readOnly" }), shellRequest, "ask"),
    "deny",
  );
});

it("never leaves a Supervised thread in a wider mode when Vibe hides Ask", () => {
  assert.equal(mistralVibeSessionMode(policy("approval-required"), ["accept-edits"]), "ask");
  assert.equal(mistralVibeSessionMode(policy("approval-required"), []), undefined);
});
