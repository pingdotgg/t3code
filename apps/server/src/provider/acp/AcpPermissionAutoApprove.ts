import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Picks the broadest allow option offered by the agent, preferring
 * `allow_always` so a session is not asked again for the same tool.
 * Returns `undefined` when the agent offered no usable allow option.
 */
export function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  for (const kind of ["allow_always", "allow_once"] as const) {
    const optionId = request.options.find((entry) => entry.kind === kind)?.optionId.trim();
    if (optionId) {
      return optionId;
    }
  }
  return undefined;
}

/**
 * Registers a `session/request_permission` handler that auto-approves every
 * permission request. Headless sessions (auto-review, commit message, and PR
 * content text generation) have no user present to approve; an unanswered
 * request stalls the turn or makes the agent abort it, which surfaces as
 * empty or invalid structured output.
 */
export const registerAutoApprovePermissionHandler = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "handleRequestPermission">,
): Effect.Effect<void> =>
  runtime.handleRequestPermission((params) => {
    const optionId = selectAutoApprovedPermissionOption(params);
    return Effect.succeed(
      optionId === undefined
        ? { outcome: { outcome: "cancelled" as const } }
        : { outcome: { outcome: "selected" as const, optionId } },
    );
  });
