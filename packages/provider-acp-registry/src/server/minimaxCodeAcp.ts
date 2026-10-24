import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import type { AcpPromptBusyRetryPolicy } from "@t3tools/provider-acp/server/promptBusyRetry";
import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/**
 * minimax-code keeps a turn lease on the session until the interrupted turn has
 * finished unwinding, and rejects any prompt that arrives while the lease is
 * still held:
 *
 *   "Session already has an active Turn. Use queue send to deliver the message
 *   after it."
 *
 * The agent never sees the rejected prompt, so the same prompt is accepted once
 * the lease is released.
 */
const MINIMAX_CODE_BUSY_PATTERN = /already has an active turn/i;

function isMinimaxCodeBusyError(error: unknown): boolean {
  return isAcpRequestError(error) && MINIMAX_CODE_BUSY_PATTERN.test(error.errorMessage);
}

export const isMinimaxCodeBusyFailure: AcpPromptBusyRetryPolicy["isBusyFailure"] = (cause) => {
  const error = Cause.findError(cause);
  return Result.isSuccess(error) && isMinimaxCodeBusyError(error.success);
};

/**
 * The lease is released within seconds of the interrupt, so a short backoff
 * recovers the turn long before the user notices a failed prompt.
 *
 * The first send plus seven re-sends land 1s, 3s, 7s, 15s, 25s, 35s and 45s
 * after the rejected attempt, so the budget covers the longest lease release
 * observed in the wild, which was 27.6s.
 */
export const minimaxCodePromptBusyRetry: AcpPromptBusyRetryPolicy = {
  maxAttempts: 8,
  isBusyFailure: isMinimaxCodeBusyFailure,
  delayMs: (attempt) => Math.min(10_000, 1_000 * 2 ** (attempt - 1)),
};

/** The id the ACP registry publishes the minimax-code agent under. */
const MINIMAX_CODE_REGISTRY_AGENT_ID = "minimax-code";

/** Local installs launch the `mcode` binary directly, with no registry id. */
const MINIMAX_CODE_LOCAL_COMMAND = /^mcode(\.exe|\.cmd)?$/i;

export interface MinimaxCodeAgentIdentity {
  /** The registry agent id, empty for a local install. */
  readonly registryAgentId: string;
  /** Whether the agent runs as a local install. */
  readonly isLocal: boolean;
  /** The local command, when the agent runs as a local install. */
  readonly commandPath: string;
}

/**
 * Whether the agent is minimax-code, either installed from the registry or
 * installed locally.
 */
export function isMinimaxCodeAgent(identity: MinimaxCodeAgentIdentity): boolean {
  if (identity.registryAgentId === MINIMAX_CODE_REGISTRY_AGENT_ID) return true;
  if (!identity.isLocal) return false;
  const command = identity.commandPath.split(/[\\/]/).pop() ?? "";
  return MINIMAX_CODE_LOCAL_COMMAND.test(command);
}

/**
 * minimax-code holds a turn lease on the session until the interrupted turn
 * has finished unwinding, so a prompt that arrives in that window is re-sent
 * instead of failing the turn.
 */
export function minimaxCodeFlavorExtras(
  identity: MinimaxCodeAgentIdentity,
): Pick<AcpAdapterV2Flavor, "promptBusyRetry"> {
  return isMinimaxCodeAgent(identity) ? { promptBusyRetry: minimaxCodePromptBusyRetry } : {};
}
