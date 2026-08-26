import { buildReferralLink, normalizeReferralCode } from "@t3tools/shared/referral";

export const PENDING_REFERRAL_CODE_STORAGE_KEY = "t3code.pending-referral-code";

export function referralCodeFromUrl(url: URL): string | null {
  return normalizeReferralCode(url.searchParams.get("ref") ?? "");
}

export function urlWithoutReferralCode(url: URL): string {
  const next = new URL(url);
  next.searchParams.delete("ref");
  return `${next.pathname}${next.search}${next.hash}`;
}

export { buildReferralLink, normalizeReferralCode };
