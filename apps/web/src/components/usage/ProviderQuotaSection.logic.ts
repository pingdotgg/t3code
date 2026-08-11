import {
  type ProviderInstanceId,
  type ProviderQuotaConsumeResetInput,
  type ProviderQuotaConsumeResetOutcome,
} from "@t3tools/contracts";

import type { ProviderUsageStripItem } from "../sidebar/ProviderUsageStrip.logic";

export function resolveSelectedProviderQuotaItem(
  items: ReadonlyArray<ProviderUsageStripItem>,
  requestedInstanceId: ProviderInstanceId | null,
): ProviderUsageStripItem | null {
  return items.find((item) => item.instanceId === requestedInstanceId) ?? items[0] ?? null;
}

export interface ProviderResetAttemptState {
  readonly idempotencyKey: string | null;
  readonly creditId?: ProviderQuotaConsumeResetInput["creditId"];
  readonly pending: boolean;
  readonly feedback: string | null;
}

export interface ConfirmedProviderResetAttemptState extends ProviderResetAttemptState {
  readonly idempotencyKey: string;
  readonly creditId: ProviderQuotaConsumeResetInput["creditId"];
  readonly pending: true;
  readonly feedback: null;
}

export function createProviderResetAttemptState(): ProviderResetAttemptState {
  return { idempotencyKey: null, pending: false, feedback: null };
}

export function confirmProviderResetAttempt(
  state: ProviderResetAttemptState,
  creditId: ProviderQuotaConsumeResetInput["creditId"],
  createIdempotencyKey: () => string,
): ConfirmedProviderResetAttemptState {
  const idempotencyKey =
    state.idempotencyKey !== null && state.creditId === creditId
      ? state.idempotencyKey
      : createIdempotencyKey();
  return {
    idempotencyKey,
    creditId,
    pending: true,
    feedback: null,
  };
}

const RESET_OUTCOME_FEEDBACK: Record<ProviderQuotaConsumeResetOutcome, string> = {
  reset: "Reset applied. Quota has been refreshed.",
  nothingToReset: "There was no quota to reset.",
  noCredit: "This reset credit is no longer available.",
  alreadyRedeemed: "This reset was already redeemed.",
};

export function settleProviderResetAttempt(
  state: ProviderResetAttemptState,
  result:
    | { readonly kind: "outcome"; readonly outcome: ProviderQuotaConsumeResetOutcome }
    | { readonly kind: "transportError"; readonly message: string },
): ProviderResetAttemptState {
  if (result.kind === "outcome") {
    return {
      idempotencyKey: null,
      pending: false,
      feedback: RESET_OUTCOME_FEEDBACK[result.outcome],
    };
  }
  return {
    idempotencyKey: state.idempotencyKey,
    ...(state.creditId === undefined ? {} : { creditId: state.creditId }),
    pending: false,
    feedback: result.message,
  };
}

export function cancelProviderResetAttempt(
  state: ProviderResetAttemptState,
): ProviderResetAttemptState {
  return state.idempotencyKey === null
    ? createProviderResetAttemptState()
    : {
        idempotencyKey: state.idempotencyKey,
        ...(state.creditId === undefined ? {} : { creditId: state.creditId }),
        pending: false,
        feedback: null,
      };
}
