import { assert, it } from "@effect/vitest";
import type { RuntimeMode } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as EffectAcpSchema from "effect-acp/compat";

import { mistralVibePermissionDisposition } from "./mistralVibeAcp.ts";

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

it("hands every call Smart Approve flags to the user under auto", () => {
  assert.equal(mistralVibePermissionDisposition(policy("auto"), shellRequest), "ask");
  assert.equal(mistralVibePermissionDisposition(policy("full-access"), shellRequest), "allow");
  assert.equal(
    mistralVibePermissionDisposition(policy("auto", { type: "readOnly" }), shellRequest),
    "deny",
  );
});
