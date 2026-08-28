import type { RelayReferralClaimResult } from "@t3tools/contracts/relay";
import { REFERRAL_AWARD_POINTS } from "@t3tools/shared/referral";

export interface ReferralClaimMessage {
  readonly type: "success" | "warning" | "info";
  readonly title: string;
  readonly description?: string;
}

export function referralClaimMessage(
  result: RelayReferralClaimResult,
  awardPoints = REFERRAL_AWARD_POINTS,
): ReferralClaimMessage {
  switch (result) {
    case "claimed":
      return {
        type: "success",
        title: "Referral applied",
        description: `Your referrer will receive ${awardPoints} points after you link your first environment.`,
      };
    case "already_claimed":
      return { type: "info", title: "This account already claimed a referral" };
    case "invalid_code":
      return { type: "warning", title: "This referral code is not valid" };
    case "self_referral":
      return { type: "warning", title: "You cannot use a referral code from your account chain" };
    case "ineligible":
      return {
        type: "info",
        title: "Referral code not applied",
        description: "Referral codes must be claimed before linking an environment.",
      };
  }
}
