import { useAuth } from "@clerk/react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { RelayReferralClaimResult } from "@t3tools/contracts/relay";
import { useEffect, useRef } from "react";

import {
  claimManagedRelayReferralCommand,
  refreshManagedRelayReferralSummary,
} from "../../cloud/managedRelayState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import {
  PENDING_REFERRAL_CODE_STORAGE_KEY,
  referralCodeFromUrl,
  urlWithoutReferralCode,
} from "../../cloud/referralLinks";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

function clearPendingReferralCode(): void {
  try {
    window.localStorage.removeItem(PENDING_REFERRAL_CODE_STORAGE_KEY);
  } catch {
    // The referral query parameter still gets removed when storage is unavailable.
  }
}

function readPendingReferralCode(): string | null {
  try {
    return window.localStorage.getItem(PENDING_REFERRAL_CODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function captureReferralCode(): void {
  const url = new URL(window.location.href);
  const referralCode = referralCodeFromUrl(url);
  if (!referralCode) return;
  try {
    window.localStorage.setItem(PENDING_REFERRAL_CODE_STORAGE_KEY, referralCode);
  } catch {
    return;
  }
  window.history.replaceState(window.history.state, "", urlWithoutReferralCode(url));
}

function showClaimResult(result: RelayReferralClaimResult): void {
  switch (result) {
    case "claimed":
      toastManager.add({
        type: "success",
        title: "Referral applied",
        description: "Your referrer will receive 67 points after you link your first environment.",
      });
      return;
    case "already_claimed":
      return;
    case "invalid_code":
      toastManager.add({ type: "warning", title: "This referral code is not valid" });
      return;
    case "self_referral":
      toastManager.add({ type: "warning", title: "You cannot use your own referral code" });
      return;
    case "ineligible":
      toastManager.add({
        type: "info",
        title: "Referral code not applied",
        description: "Referral codes must be claimed before linking an environment.",
      });
  }
}

export function ReferralClaimCoordinator() {
  if (!hasCloudPublicConfig()) return null;
  return <ConfiguredReferralClaimCoordinator />;
}

function ConfiguredReferralClaimCoordinator() {
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const claimReferral = useAtomCommand(claimManagedRelayReferralCommand, {
    reportFailure: false,
  });
  const attemptedClaimRef = useRef<string | null>(null);

  useEffect(() => {
    captureReferralCode();
  }, []);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId) return;
    const referralCode = readPendingReferralCode();
    if (!referralCode) return;
    const attemptKey = `${userId}:${referralCode}`;
    if (attemptedClaimRef.current === attemptKey) return;
    attemptedClaimRef.current = attemptKey;

    void (async () => {
      const result = await claimReferral({ accountId: userId, referralCode });
      if (result._tag === "Success") {
        clearPendingReferralCode();
        refreshManagedRelayReferralSummary();
        showClaimResult(result.value.result);
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      console.error("[t3-cloud] Could not claim captured referral code", { cause });
    })();
  }, [claimReferral, isLoaded, isSignedIn, userId]);

  return null;
}
