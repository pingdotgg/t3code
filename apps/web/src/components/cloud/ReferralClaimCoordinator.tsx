import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  claimManagedRelayReferralCommand,
  refreshManagedRelayReferralSummary,
} from "../../cloud/managedRelayState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { referralClaimMessage } from "../../cloud/referralClaimResult";
import {
  captureReferralCodeFromUrl,
  clearPendingReferralCode,
  PENDING_REFERRAL_CODE_STORAGE_KEY,
  readPendingReferralCode,
  urlWithoutMatchingReferralCode,
} from "../../cloud/referralLinks";
import { useAtomCommand } from "../../state/use-atom-command";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { toastManager } from "../ui/toast";
import { stackedThreadToast } from "../ui/toastHelpers";
import {
  claimReferralWithRetry,
  isCurrentReferralClaimAttempt,
  type ReferralClaimAttempt,
} from "./ReferralClaimCoordinator.logic";

function captureReferralCode(): string | null {
  const url = new URL(window.location.href);
  const captured = captureReferralCodeFromUrl(url, (referralCode) => {
    window.localStorage.setItem(PENDING_REFERRAL_CODE_STORAGE_KEY, referralCode);
  });
  if (!captured) return null;
  if (captured.cleanedUrl) {
    window.history.replaceState(window.history.state, "", captured.cleanedUrl);
  }
  return captured.referralCode;
}

function clearReferralCodeFromUrl(referralCode: string): void {
  const url = new URL(window.location.href);
  const cleanedUrl = urlWithoutMatchingReferralCode(url, referralCode);
  if (!cleanedUrl) return;
  window.history.replaceState(window.history.state, "", cleanedUrl);
}

export function ReferralClaimCoordinator() {
  if (!hasCloudPublicConfig()) return null;
  return <ConfiguredReferralClaimCoordinator />;
}

function ConfiguredReferralClaimCoordinator() {
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const locationHref = useLocation({ select: (location) => location.href });
  const claimReferral = useAtomCommand(claimManagedRelayReferralCommand, {
    reportFailure: false,
  });
  const relayAccountId = useAtomValue(managedRelaySessionAtom)?.accountId ?? null;
  const { authPrompt, openAuthPrompt } = useT3ConnectAuthPrompt();
  const [pendingReferralCode, setPendingReferralCode] = useState<string | null>(null);
  const activeClaimRef = useRef<ReferralClaimAttempt | null>(null);
  const completedClaimRef = useRef<string | null>(null);
  const retryToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const initializedReferralRef = useRef(false);
  const promptedSignInRef = useRef<string | null>(null);
  const shouldPromptSignInRef = useRef(false);
  const closeRetryToast = useCallback(() => {
    if (retryToastIdRef.current === null) return;
    toastManager.close(retryToastIdRef.current);
    retryToastIdRef.current = null;
  }, []);

  useEffect(() => {
    const capturedCode = captureReferralCode();
    if (!capturedCode && initializedReferralRef.current) return;
    initializedReferralRef.current = true;
    shouldPromptSignInRef.current = capturedCode !== null;
    setPendingReferralCode(capturedCode ?? readPendingReferralCode());
  }, [locationHref]);

  useEffect(() => {
    if (!isLoaded || isSignedIn || !pendingReferralCode || !shouldPromptSignInRef.current) return;
    if (promptedSignInRef.current === pendingReferralCode) return;
    promptedSignInRef.current = pendingReferralCode;
    toastManager.add({
      type: "info",
      title: "Referral link ready",
      description: "Sign in to claim it before linking your first environment.",
    });
    openAuthPrompt();
  }, [isLoaded, isSignedIn, openAuthPrompt, pendingReferralCode]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId || relayAccountId !== userId) return;
    const referralCode = pendingReferralCode ?? readPendingReferralCode();
    if (!referralCode) return;
    const attemptKey = `${userId}:${referralCode}`;
    const attempt = { key: attemptKey };
    let isCancelled = false;
    const isCurrentAttempt = () =>
      isCurrentReferralClaimAttempt(isCancelled, activeClaimRef.current, attempt);

    const runClaim = async () => {
      if (isCancelled) return;
      if (activeClaimRef.current?.key === attemptKey || completedClaimRef.current === attemptKey)
        return;
      activeClaimRef.current = attempt;
      try {
        const result = await claimReferralWithRetry({
          claim: () => claimReferral({ accountId: userId, referralCode }),
          shouldContinue: isCurrentAttempt,
          shouldRetry: (claimResult) =>
            isCurrentAttempt() &&
            claimResult._tag !== "Success" &&
            !isAtomCommandInterrupted(claimResult),
        });
        if (result._tag === "Success") {
          if (!isCurrentAttempt()) return;
          completedClaimRef.current = attemptKey;
          closeRetryToast();
          clearPendingReferralCode();
          clearReferralCodeFromUrl(referralCode);
          setPendingReferralCode(null);
          refreshManagedRelayReferralSummary();
          if (result.value.result !== "already_claimed") {
            toastManager.add(
              referralClaimMessage(result.value.result, result.value.summary.awardPoints),
            );
          }
          return;
        }
        if (!isCurrentAttempt() || isAtomCommandInterrupted(result)) return;
        const cause = squashAtomCommandFailure(result);
        console.error("[t3-cloud] Could not claim captured referral code", { cause });
        const retryToast = stackedThreadToast({
          type: "error",
          title: "Referral still pending",
          description: "Retry before linking an environment so your referrer can receive points.",
          timeout: 0,
          actionProps: {
            children: "Retry",
            onClick: () => void runClaim(),
          },
          data: {
            onClose: () => {
              retryToastIdRef.current = null;
            },
          },
        });
        if (retryToastIdRef.current === null) {
          retryToastIdRef.current = toastManager.add(retryToast);
        } else {
          toastManager.update(retryToastIdRef.current, retryToast);
        }
      } finally {
        if (activeClaimRef.current === attempt) activeClaimRef.current = null;
      }
    };

    void runClaim();
    return () => {
      isCancelled = true;
      if (activeClaimRef.current === attempt) activeClaimRef.current = null;
      closeRetryToast();
    };
  }, [
    claimReferral,
    closeRetryToast,
    isLoaded,
    isSignedIn,
    pendingReferralCode,
    relayAccountId,
    userId,
  ]);

  return authPrompt;
}
