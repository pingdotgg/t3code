import type { RuntimeMode } from "@t3tools/contracts";
import {
  acpPermissionDisposition,
  type AcpPermissionDisposition,
} from "@t3tools/provider-acp/server/clientPolicy";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as EffectAcpSchema from "effect-acp/compat";

import type { AcpRegistrySettings } from "../settings.ts";

/** Vibe's `mode` option; its modes are permission levels, so T3's access mode owns it. */
export const MISTRAL_VIBE_MODE_OPTION_ID = "mode";

export const isMistralVibeAgent = (settings: AcpRegistrySettings): boolean =>
  settings.source !== "local" && settings.agentId === "mistral-vibe";

// A delegated approval or sandbox policy is decided in T3, so Vibe must ask about every call.
function mistralVibeRuntimeMode(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): RuntimeMode {
  return policy.approvalPolicy === undefined && policy.sandboxPolicy === undefined
    ? policy.runtimeMode
    : "approval-required";
}

// The first advertised mode wins; none grants more than its runtime mode.
const MISTRAL_VIBE_MODES: Record<RuntimeMode, ReadonlyArray<string>> = {
  "approval-required": ["ask"],
  "auto-accept-edits": ["accept-edits", "ask"],
  auto: ["smart-approve", "ask"],
  "full-access": ["auto-approve", "accept-edits", "ask"],
};

export function mistralVibeSessionMode(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  advertisedModeIds: ReadonlyArray<string>,
): string | undefined {
  return MISTRAL_VIBE_MODES[mistralVibeRuntimeMode(policy)].find((id) =>
    advertisedModeIds.includes(id),
  );
}

/** Smart Approve asks only about calls its classifier finds risky; T3 must not approve those itself. */
export function mistralVibePermissionDisposition(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  return mistralVibeRuntimeMode(policy) === "auto"
    ? "ask"
    : acpPermissionDisposition(policy, request);
}
