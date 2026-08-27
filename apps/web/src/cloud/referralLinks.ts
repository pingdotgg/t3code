import {
  buildReferralLink,
  buildReferralShareMessage,
  normalizeReferralCode,
  REFERRAL_SHARE_TITLE,
} from "@t3tools/shared/referral";

export const PENDING_REFERRAL_CODE_STORAGE_KEY = "t3code.pending-referral-code";

let inMemoryPendingReferralCode: string | null = null;

export function persistPendingReferralCode(
  referralCode: string,
  getStorage: () => Pick<Storage, "setItem"> = () => window.localStorage,
): boolean {
  const normalized = normalizeReferralCode(referralCode);
  if (!normalized) return false;

  inMemoryPendingReferralCode = normalized;
  try {
    getStorage().setItem(PENDING_REFERRAL_CODE_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

export function readPendingReferralCode(
  getStorage: () => Pick<Storage, "getItem"> = () => window.localStorage,
): string | null {
  try {
    const storage = getStorage();
    return (
      inMemoryPendingReferralCode ??
      normalizeReferralCode(storage.getItem(PENDING_REFERRAL_CODE_STORAGE_KEY) ?? "")
    );
  } catch {
    return inMemoryPendingReferralCode;
  }
}

export function clearPendingReferralCode(
  getStorage: () => Pick<Storage, "removeItem"> = () => window.localStorage,
): void {
  inMemoryPendingReferralCode = null;
  try {
    getStorage().removeItem(PENDING_REFERRAL_CODE_STORAGE_KEY);
  } catch {}
}

export function referralCodeFromUrl(url: URL): string | null {
  return normalizeReferralCode(url.searchParams.get("ref") ?? "");
}

export function urlWithoutReferralCode(url: URL): string {
  const next = new URL(url);
  next.searchParams.delete("ref");
  return `${next.pathname}${next.search}${next.hash}`;
}

export function urlWithoutMatchingReferralCode(
  url: URL,
  expectedReferralCode: string,
): string | null {
  const expected = normalizeReferralCode(expectedReferralCode);
  if (!expected || referralCodeFromUrl(url) !== expected) return null;
  return urlWithoutReferralCode(url);
}

export function captureReferralCodeFromUrl(
  url: URL,
  persist: (referralCode: string) => boolean | void,
): { referralCode: string; cleanedUrl: string | null } | null {
  const referralCode = referralCodeFromUrl(url);
  if (!referralCode) return null;

  try {
    if (persist(referralCode) === false) {
      return { referralCode, cleanedUrl: null };
    }
  } catch {
    return { referralCode, cleanedUrl: null };
  }

  return { referralCode, cleanedUrl: urlWithoutReferralCode(url) };
}

export function buildReferralShareData(referralLink: string, awardPoints?: number) {
  return {
    title: REFERRAL_SHARE_TITLE,
    text: buildReferralShareMessage(referralLink, awardPoints),
    url: referralLink,
  };
}

export { buildReferralLink, normalizeReferralCode };
