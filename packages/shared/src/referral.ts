export const REFERRAL_CODE_LENGTH = 16;
const REFERRAL_CODE_PATTERN = new RegExp(`^[A-F0-9]{${REFERRAL_CODE_LENGTH}}$`, "u");

export function normalizeReferralCode(value: string): string | null {
  const code = value.trim().replaceAll("-", "").toUpperCase();
  return REFERRAL_CODE_PATTERN.test(code) ? code : null;
}

export function buildReferralLink(hostedAppUrl: string, referralCode: string): string {
  const url = new URL("/", hostedAppUrl);
  url.searchParams.set("ref", referralCode);
  return url.toString();
}
