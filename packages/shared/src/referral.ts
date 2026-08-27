const REFERRAL_CODE_LENGTH = 16;
const REFERRAL_CODE_PATTERN = new RegExp(`^[A-F0-9]{${REFERRAL_CODE_LENGTH}}$`, "u");
export const REFERRAL_SHARE_TITLE = "T3 Code referral";
export const REFERRAL_AWARD_POINTS = 67;

export function normalizeReferralCode(value: string): string | null {
  const code = value.trim().replaceAll("-", "").toUpperCase();
  return REFERRAL_CODE_PATTERN.test(code) ? code : null;
}

export function buildReferralLink(hostedAppUrl: string, referralCode: string): string {
  const normalized = normalizeReferralCode(referralCode);
  if (!normalized) {
    throw new Error("Referral links require a valid 16-character referral code.");
  }
  const url = new URL("/", hostedAppUrl);
  url.searchParams.set("ref", normalized);
  return url.toString();
}

export function buildReferralShareMessage(
  referralLink: string,
  awardPoints = REFERRAL_AWARD_POINTS,
): string {
  return `Try T3 Code with my referral. If you claim it before linking your first environment, I get ${awardPoints} points.\n${referralLink}`;
}
