import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { RelayReferralClaimResult } from "@t3tools/contracts/relay";
import { CheckIcon, CopyIcon, GiftIcon, LinkIcon, Share2Icon, TicketCheckIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import {
  claimManagedRelayReferralCommand,
  useManagedRelayReferralSummary,
} from "../../cloud/managedRelayState";
import {
  buildReferralLink,
  buildReferralShareData,
  normalizeReferralCode,
} from "../../cloud/referralLinks";
import { configuredHostedAppUrl } from "../../hostedPairing";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import {
  ClerkUserProfileIcon,
  ClerkUserProfilePage,
  ClerkUserProfileRefreshButton,
} from "./ClerkUserProfilePage";

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

function ReferralMetric(props: { readonly label: string; readonly value: number }) {
  return (
    <div className="min-w-0 rounded-lg px-3 py-3 sm:px-4">
      <dt className="text-[0.6875rem] leading-4 font-medium text-muted-foreground">
        {props.label}
      </dt>
      <dd className="mt-0.5 text-2xl leading-8 font-semibold tracking-tight tabular-nums">
        {props.value}
      </dd>
    </div>
  );
}

function ReferralSectionHeading({
  icon,
  title,
  description,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <ClerkUserProfileIcon>{icon}</ClerkUserProfileIcon>
      <div className="min-w-0 pt-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-0.5 max-w-[30rem] text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}

export function ReferralsUserProfilePage() {
  const summaryState = useManagedRelayReferralSummary();
  const claimReferral = useAtomCommand(claimManagedRelayReferralCommand, {
    reportFailure: false,
  });
  const [referralCode, setReferralCode] = useState("");
  const [isClaiming, setIsClaiming] = useState(false);
  const { copyToClipboard: copyReferralLink, isCopied: isLinkCopied } = useCopyToClipboard({
    target: "referral link",
    onCopy: () => toastManager.add({ type: "success", title: "Referral link copied" }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Could not copy referral link",
        description: error.message,
      }),
  });
  const { copyToClipboard: copyReferralCode, isCopied: isCodeCopied } = useCopyToClipboard({
    target: "referral code",
    onCopy: () => toastManager.add({ type: "success", title: "Referral code copied" }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Could not copy referral code",
        description: error.message,
      }),
  });
  const summary = summaryState.data;
  const referralLink = useMemo(
    () => (summary ? buildReferralLink(configuredHostedAppUrl(), summary.referralCode) : null),
    [summary],
  );
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

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

  const shareReferral = async () => {
    if (!referralLink) return;
    if (!canShare) {
      await copyReferralLink(referralLink);
      return;
    }

    try {
      await navigator.share(buildReferralShareData(referralLink));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      toastManager.add({
        type: "error",
        title: "Could not share referral link",
        description: error instanceof Error ? error.message : "Try copying the link instead.",
      });
    }
  };

  const isInitialLoad =
    !summaryState.accountId || (summaryState.data === null && !summaryState.error);

  return (
    <ClerkUserProfilePage
      title="Referrals"
      description="Earn 67 points when a friend claims your link before connecting their first environment. Your balance follows your T3 account."
      action={
        <ClerkUserProfileRefreshButton
          disabled={isClaiming}
          isPending={summaryState.isPending}
          onClick={summaryState.refresh}
        />
      }
    >
      {summaryState.error ? (
        <div className="mb-3 rounded-lg bg-destructive/8 px-3 py-2.5 text-[0.8125rem]" role="alert">
          <p className="font-medium text-destructive-foreground">Could not load referral points</p>
          <p className="mt-1 text-xs text-muted-foreground">{summaryState.error}</p>
        </div>
      ) : null}

      {isInitialLoad ? (
        <Card
          className="rounded-xl border-border/40 bg-muted/20 p-2 shadow-none before:hidden"
          aria-label="Loading referrals"
          role="status"
        >
          <div className="grid grid-cols-3 gap-1.5">
            <div className="p-2">
              <Skeleton className="h-11 rounded-lg" />
            </div>
            <div className="p-2">
              <Skeleton className="h-11 rounded-lg" />
            </div>
            <div className="p-2">
              <Skeleton className="h-11 rounded-lg" />
            </div>
          </div>
        </Card>
      ) : summary ? (
        <div className="space-y-3">
          <Card className="rounded-xl border-border/40 bg-muted/20 p-2 shadow-none before:hidden">
            <dl className="grid grid-cols-3 gap-1.5">
              <ReferralMetric label="Points" value={summary.points} />
              <ReferralMetric label="Successful" value={summary.qualifiedReferrals} />
              <ReferralMetric label="Pending" value={summary.pendingReferrals} />
            </dl>
          </Card>

          <Card className="rounded-xl border-border/40 bg-card/60 shadow-none before:hidden">
            <CardContent className="p-4 sm:p-5">
              <ReferralSectionHeading
                icon={<GiftIcon className="size-4" />}
                title="Invite someone"
                description="They need to claim your link before linking their first T3 Code environment."
              />
              <div className="mt-4 space-y-2 sm:ml-11">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1 rounded-lg bg-muted/40 px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-[0.6875rem] font-medium text-muted-foreground">
                      <LinkIcon className="size-3" aria-hidden="true" />
                      Referral link
                    </div>
                    <p className="mt-0.5 truncate text-xs">{referralLink}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0 text-[0.8125rem]"
                    disabled={!referralLink}
                    onClick={() => void shareReferral()}
                  >
                    {canShare ? (
                      <Share2Icon className="size-3.5" aria-hidden="true" />
                    ) : isLinkCopied ? (
                      <CheckIcon className="size-3.5" aria-hidden="true" />
                    ) : (
                      <CopyIcon className="size-3.5" aria-hidden="true" />
                    )}
                    {canShare ? "Share" : isLinkCopied ? "Copied" : "Copy link"}
                  </Button>
                </div>
                <div className="flex items-center justify-between gap-3 px-1 py-1">
                  <div className="min-w-0">
                    <span className="text-[0.6875rem] font-medium text-muted-foreground">
                      Referral code
                    </span>
                    <code className="ml-2 text-xs tracking-[0.04em]">{summary.referralCode}</code>
                  </div>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={isCodeCopied ? "Referral code copied" : "Copy referral code"}
                    onClick={() => copyReferralCode(summary.referralCode)}
                  >
                    {isCodeCopied ? (
                      <CheckIcon className="size-3.5" aria-hidden="true" />
                    ) : (
                      <CopyIcon className="size-3.5" aria-hidden="true" />
                    )}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {!summary.hasClaimedReferral ? (
            <Card className="rounded-xl border-border/40 bg-card/60 shadow-none before:hidden">
              <CardContent className="p-4 sm:p-5">
                <ReferralSectionHeading
                  icon={<TicketCheckIcon className="size-4" />}
                  title="Use a referral code"
                  description="Apply it before linking your first environment."
                />
                <div className="mt-4 flex flex-col gap-2 sm:ml-11 sm:flex-row">
                  <Input
                    autoCapitalize="characters"
                    autoComplete="off"
                    autoCorrect="off"
                    className="border-border/45 bg-muted/28 shadow-none before:hidden dark:bg-muted/28"
                    nativeInput
                    size="sm"
                    spellCheck={false}
                    value={referralCode}
                    placeholder="ABCD1234EFAB5678"
                    aria-label="Referral code"
                    disabled={isClaiming}
                    onChange={(event) => setReferralCode(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submitReferralCode();
                    }}
                  />
                  <Button
                    size="sm"
                    className="shrink-0 text-[0.8125rem]"
                    disabled={isClaiming}
                    onClick={() => void submitReferralCode()}
                  >
                    {isClaiming ? "Applying..." : "Apply code"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}
    </ClerkUserProfilePage>
  );
}
