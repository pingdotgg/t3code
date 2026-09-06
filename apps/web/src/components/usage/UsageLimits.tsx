import {
  type EnvironmentId,
  type ProviderConsumeResetCreditOutcome,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderResetCredits,
  ServerProviderUsageWindow,
  UsageProviderKind,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  elapsedShare,
  formatDuration,
  formatResetsIn,
  type LimitPace,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { PROVIDER_PRESENTATION } from "./usageProviders";

const PACE: Record<LimitPace, { readonly label: string; readonly icon: typeof GaugeIcon }> = {
  ahead: { label: "Ahead of pace: spending faster than the window elapses", icon: TrendingUpIcon },
  on: { label: "On pace with the window", icon: GaugeIcon },
  under: { label: "Under pace: headroom left for the rest of the window", icon: TrendingDownIcon },
};

/** The series colour the cost chart uses for this driver, so the two views read as one. */
export function barColor(driver: ServerProvider["driver"]): string {
  const kind: UsageProviderKind | undefined =
    driver === "codex" ? "codex" : driver === "claudeAgent" ? "claude" : undefined;
  return kind ? PROVIDER_PRESENTATION[kind].color : "var(--foreground)";
}

/** Pace as a glyph with the words on hover. */
export function PaceIcon({ pace }: { readonly pace: LimitPace }) {
  const Icon = PACE[pace].icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={PACE[pace].label}
            className="inline-flex text-muted-foreground"
          />
        }
      >
        <Icon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="top">{PACE[pace].label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * One window as a full-width bar from the moment it opened to its reset.
 * The fill is the share of quota spent; the hairline is how far into the
 * window the clock is, which is also where even spending would have put the
 * fill. Hover for the exact figures and reset time.
 */
function WindowBar({
  color,
  window,
  now,
}: {
  readonly color: string;
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const remaining = remainingPercent(window);
  const elapsed = elapsedShare(window, now);
  // The fill is quota left, so the even-spending mark is the time left.
  const timeLeft = elapsed === null ? null : Math.round((1 - elapsed) * 100);
  const resetsIn = formatResetsIn(window, now);
  const resetsAt = window.resetsAt
    ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)
    : null;
  const summary = `${window.label}: ${remaining}% left${
    timeLeft === null ? "" : `, ${timeLeft}% of the window left`
  }${resetsIn ? `, ${resetsIn}` : ""}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="img"
            aria-label={summary}
            tabIndex={0}
            className="relative h-6 cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        }
      >
        <div className="absolute inset-x-0 inset-y-1.5 rounded-full bg-muted" />
        {remaining > 0 ? (
          <div
            className="absolute inset-y-1.5 left-0 rounded-full"
            style={{ width: `${remaining}%`, backgroundColor: color }}
          />
        ) : null}
        {timeLeft !== null ? (
          <span
            aria-hidden
            className="absolute inset-y-0.5 w-px -translate-x-1/2 bg-foreground/60"
            style={{ left: `${timeLeft}%` }}
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72 text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {remaining}% left{timeLeft !== null ? ` · ${timeLeft}% of the window left` : ""}
          </span>
          {timeLeft !== null ? (
            <span className="text-muted-foreground">The line is where even spending would be.</span>
          ) : null}
          {resetsAt ? (
            <span className="text-muted-foreground">
              Resets {resetsAt}
              {resetsIn ? ` · ${resetsIn}` : ""}
            </span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * One account's windows as rows: label and percent, bar, pace and countdown.
 * Compact rows fit the composer panel with narrower columns.
 */
export function LimitWindows({
  driver,
  windows,
  now,
  compact = false,
}: {
  readonly driver: ServerProvider["driver"];
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly now: number;
  readonly compact?: boolean;
}) {
  const color = barColor(driver);
  return (
    <div
      className={
        compact
          ? "grid grid-cols-[minmax(0,9rem)_minmax(3rem,1fr)_auto] gap-x-3 gap-y-0.5"
          : "grid grid-cols-[11rem_minmax(0,1fr)_7rem] gap-x-4 gap-y-1"
      }
    >
      {windows.map((window) => {
        const pace = paceOf(window, now);
        const resetsIn = formatResetsIn(window, now);
        return (
          <Fragment key={window.id}>
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground">{window.label}</span>
              <span className="ms-auto shrink-0 font-medium text-foreground tabular-nums">
                {remainingPercent(window)}% left
              </span>
            </span>
            <WindowBar color={color} window={window} now={now} />
            <span className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {pace ? <PaceIcon pace={pace} /> : null}
              <span className="ms-auto shrink-0">{resetsIn ?? ""}</span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

const OUTCOME_TEXT: Record<ProviderConsumeResetCreditOutcome, string> = {
  reset: "Reset applied. Your windows have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
};

/** Everything a redeem needs: where to send it and what to say afterwards. */
export function useResetCredit(environmentId: EnvironmentId, instanceId: ProviderInstanceId) {
  const consume = useAtomCommand(serverEnvironment.consumeResetCredit, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const redeem = async () => {
    setConfirming(false);
    setBusy(true);
    setStatus(null);
    const result = await consume({ environmentId, input: { instanceId } });
    setBusy(false);
    if (result._tag === "Success") {
      setStatus(OUTCOME_TEXT[result.value.outcome]);
      return;
    }
    setStatus(
      "error" in result.cause && result.cause.error instanceof Error
        ? result.cause.error.message
        : "Could not use the reset credit.",
    );
  };

  return { confirming, setConfirming, busy, status, redeem };
}

/**
 * The confirm for a redeem. Redeeming spends a credit the provider granted the
 * user, so it never fires on a bare click. Mount it outside any popover that
 * holds the button: dialogs stack under popovers, and closing the popover
 * would unmount a dialog rendered inside it.
 */
export function ResetCreditDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Use a reset credit?</AlertDialogTitle>
          <AlertDialogDescription>
            This redeems one credit on your account and clears the current rate-limit windows. It
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button onClick={onConfirm}>Use credit</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** `2 reset credits banked · next expires in 27d 23h`, or the short form for a popover. */
export function resetCreditsSummary(
  credits: ServerProviderResetCredits,
  now: number,
  compact = false,
): string {
  const expiresIn = credits.nextExpiresAt
    ? formatDuration(Date.parse(credits.nextExpiresAt) - now)
    : null;
  if (credits.availableCount === 0) return "No reset credits banked";
  if (compact)
    return `${credits.availableCount} banked${expiresIn ? ` · expires in ${expiresIn}` : ""}`;
  return `${credits.availableCount} ${credits.availableCount === 1 ? "reset credit" : "reset credits"} banked${
    expiresIn ? ` · next expires in ${expiresIn}` : ""
  }`;
}

/** Banked reset credits with the redeem button and its confirm, self-contained. */
export function ResetCredits({
  environmentId,
  instanceId,
  credits,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly credits: ServerProviderResetCredits;
  readonly now: number;
}) {
  const { confirming, setConfirming, busy, status, redeem } = useResetCredit(
    environmentId,
    instanceId,
  );
  if (credits.availableCount === 0 && status === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="tabular-nums">{resetCreditsSummary(credits, now)}</span>
      {credits.availableCount > 0 ? (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
          {busy ? "Using…" : "Use reset"}
        </Button>
      ) : null}
      {status ? <span className="text-foreground">{status}</span> : null}
      <ResetCreditDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => void redeem()}
      />
    </div>
  );
}

/**
 * Subscription quota across every connected environment's providers and hubs,
 * pooled per provider. Countdowns anchor to render time rather than ticking: a
 * live clock would repaint the page every minute for no decision-changing gain.
 */
export function UsageLimitsSection({
  selectedEnvironmentIds,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  // Anchored once per mount on purpose: countdowns must not tick (see above).
  const [now] = useState(() => Date.now());
  const selected =
    selectedEnvironmentIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id)));
  return <UsageLimitsPooled presentations={selected} now={now} />;
}
