import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { RelayReferralClaimResult } from "@t3tools/contracts/relay";
import { CheckIcon, CopyIcon, GiftIcon, TicketCheckIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  claimManagedRelayReferralCommand,
  useManagedRelayReferralSummary,
} from "../../cloud/managedRelayState";
import { buildReferralLink, normalizeReferralCode } from "../../cloud/referralLinks";
import { configuredHostedAppUrl } from "../../hostedPairing";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { ClerkUserProfilePage, ClerkUserProfileRefreshButton } from "./ClerkUserProfilePage";

function claimResultMessage(result: RelayReferralClaimResult): {
  readonly type: "success" | "warning" | "info";
  readonly title: string;
  readonly description?: string;
} {
  switch (result) {
    case "claimed":
      return {
        type: "success",
        title: "Referral applied",
        description: "Your referrer will receive 67 points after you link your first environment.",
      };
    case "already_claimed":
      return { type: "info", title: "This account already claimed a referral" };
    case "invalid_code":
      return { type: "warning", title: "This referral code is not valid" };
    case "self_referral":
      return { type: "warning", title: "You cannot use your own referral code" };
    case "ineligible":
      return {
        type: "info",
        title: "Referral code not applied",
        description: "Referral codes must be claimed before linking an environment.",
      };
  }
}

export function ReferralsUserProfilePage() {
  const summaryState = useManagedRelayReferralSummary();
  const claimReferral = useAtomCommand(claimManagedRelayReferralCommand, {
    reportFailure: false,
  });
  const [referralCode, setReferralCode] = useState("");
  const [isClaiming, setIsClaiming] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "referral link",
    onCopy: () => toastManager.add({ type: "success", title: "Referral link copied" }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Could not copy referral link",
        description: error.message,
      }),
  });
  const summary = summaryState.data;
  const referralLink = useMemo(
    () => (summary ? buildReferralLink(configuredHostedAppUrl(), summary.referralCode) : null),
    [summary],
  );

  const submitReferralCode = async () => {
    const accountId = summaryState.accountId;
    const normalized = normalizeReferralCode(referralCode);
    if (!accountId || !normalized || isClaiming) {
      if (!normalized) {
        toastManager.add({ type: "warning", title: "Enter a valid 16-character referral code" });
      }
      return;
    }

    setIsClaiming(true);
    const result = await claimReferral({ accountId, referralCode: normalized });
    setIsClaiming(false);
    if (result._tag === "Success") {
      const message = claimResultMessage(result.value.result);
      toastManager.add(message);
      setReferralCode("");
      summaryState.refresh();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not claim referral code",
      description: cause instanceof Error ? cause.message : "Try again.",
    });
  };

  const isInitialLoad =
    !summaryState.accountId || (summaryState.data === null && !summaryState.error);

  return (
    <ClerkUserProfilePage
      title="Referrals"
      description="Earn 67 points when someone you invite links their first T3 Code environment. Your points follow your T3 account across devices."
      action={
        <ClerkUserProfileRefreshButton
          disabled={isClaiming}
          isPending={summaryState.isPending}
          onClick={summaryState.refresh}
        />
      }
    >
      {summaryState.error ? (
        <div className="mb-4 border-t border-destructive/35 py-3 text-[0.8125rem]" role="alert">
          <p className="font-medium text-destructive-foreground">Could not load referral points</p>
          <p className="mt-1 text-xs text-muted-foreground">{summaryState.error}</p>
        </div>
      ) : null}

      {isInitialLoad ? (
        <div
          className="grid gap-3 border-t py-5 sm:grid-cols-3"
          aria-label="Loading referrals"
          role="status"
        >
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : summary ? (
        <div className="space-y-6 border-t py-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border bg-muted/24 p-4">
              <p className="text-xs font-medium text-muted-foreground">Points</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight">{summary.points}</p>
            </div>
            <div className="rounded-xl border bg-muted/24 p-4">
              <p className="text-xs font-medium text-muted-foreground">Successful referrals</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight">
                {summary.qualifiedReferrals}
              </p>
            </div>
            <div className="rounded-xl border bg-muted/24 p-4">
              <p className="text-xs font-medium text-muted-foreground">Pending</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight">
                {summary.pendingReferrals}
              </p>
            </div>
          </div>

          <section>
            <div className="flex items-center gap-2">
              <GiftIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              <h3 className="text-sm font-semibold">Invite someone</h3>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              They must claim the code before linking their first environment.
            </p>
            <div className="mt-3 flex gap-2">
              <Input
                nativeInput
                readOnly
                size="sm"
                value={referralLink ?? ""}
                aria-label="Referral link"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!referralLink}
                onClick={() => copyToClipboard(referralLink ?? "")}
              >
                {isCopied ? (
                  <CheckIcon className="size-3.5" aria-hidden="true" />
                ) : (
                  <CopyIcon className="size-3.5" aria-hidden="true" />
                )}
                {isCopied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              Code: {summary.referralCode}
            </p>
          </section>

          {!summary.hasClaimedReferral ? (
            <section className="rounded-xl border bg-muted/16 p-4">
              <div className="flex items-center gap-2">
                <TicketCheckIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                <h3 className="text-sm font-semibold">Have a referral code?</h3>
              </div>
              <div className="mt-3 flex gap-2">
                <Input
                  nativeInput
                  size="sm"
                  value={referralCode}
                  placeholder="ABCD1234EFAB5678"
                  aria-label="Referral code"
                  disabled={isClaiming}
                  onChange={(event) => setReferralCode(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submitReferralCode();
                  }}
                />
                <Button size="sm" disabled={isClaiming} onClick={() => void submitReferralCode()}>
                  {isClaiming ? "Applying..." : "Apply"}
                </Button>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </ClerkUserProfilePage>
  );
}
