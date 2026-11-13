import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import type { AcpPromptBusyRetryPolicy } from "@t3tools/provider-acp/server/promptBusyRetry";
import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const MINIMAX_CODE_BUSY_PATTERN =
  /^(?:MiniMax Code Runtime failed: )?Session already has an active Turn\. Use queue send to deliver the message after it\.$/i;

function isMinimaxCodeBusyError(error: unknown): boolean {
  return (
    isAcpRequestError(error) &&
    error.code === -32603 &&
    MINIMAX_CODE_BUSY_PATTERN.test(error.errorMessage)
  );
}

export const isMinimaxCodeBusyFailure: AcpPromptBusyRetryPolicy["isBusyFailure"] = (cause) => {
  const error = Cause.findError(cause);
  return Result.isSuccess(error) && isMinimaxCodeBusyError(error.success);
};

// Seven retries span 45 seconds, covering the observed 27.6-second lease release.
export const minimaxCodePromptBusyRetry: AcpPromptBusyRetryPolicy = {
  maxAttempts: 8,
  isBusyFailure: isMinimaxCodeBusyFailure,
  delayMs: (attempt) => Math.min(10_000, 1_000 * 2 ** (attempt - 1)),
};

const MINIMAX_CODE_REGISTRY_AGENT_ID = "minimax-code";

const MINIMAX_CODE_LOCAL_COMMAND = /^mcode(\.exe|\.cmd)?$/i;

export interface MinimaxCodeAgentIdentity {
  readonly registryAgentId: string;
  readonly isLocal: boolean;
  readonly commandPath: string;
}

function isMinimaxCodeAgent(identity: MinimaxCodeAgentIdentity): boolean {
  if (identity.registryAgentId === MINIMAX_CODE_REGISTRY_AGENT_ID) return true;
  if (!identity.isLocal) return false;
  const command = identity.commandPath.split(/[\\/]/).pop() ?? "";
  return MINIMAX_CODE_LOCAL_COMMAND.test(command);
}

export function minimaxCodeFlavorExtras(
  identity: MinimaxCodeAgentIdentity,
): Pick<AcpAdapterV2Flavor, "promptBusyRetry"> {
  return isMinimaxCodeAgent(identity) ? { promptBusyRetry: minimaxCodePromptBusyRetry } : {};
}
