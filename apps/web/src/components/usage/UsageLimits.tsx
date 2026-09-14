import {
  type EnvironmentId,
  type ProviderConsumeResetCreditOutcome,
  ProviderConsumeResetCreditInput,
  ServerProvider,
  ServerProviderResetCredits,
  ServerProviderUsageWindow,
  UsageProviderKind,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  evenPaceRemainingPercent,
  formatAllowancePace,
  formatDuration,
  formatResetsIn,
  type LimitPaceDetail,
  paceDetail,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
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

/** The series colour the cost chart uses for this driver, so the two views read as one. */
export function barColor(driver: ServerProvider["driver"]): string {
  const kind: UsageProviderKind | undefined =
    driver === "codex" ? "codex" : driver === "claudeAgent" ? "claude" : undefined;
  return kind ? PROVIDER_PRESENTATION[kind].color : "var(--foreground)";
}

function paceMarkClass(detail: LimitPaceDetail): string {
  switch (detail.status) {
    case "reserve":
      return "bg-success";
    case "deficit":
      return "bg-destructive";
    case "on":
      return "bg-white";
    default: {
      const _exhaustive: never = detail.status;
      throw new Error(`Unhandled pace status: ${_exhaustive}`);
    }
  }
}

/**
 * Thin tick on the bar at even pace. Green is reserve, red is deficit.
 * It overshoots the track by 10% on each side so it reads as a mark, not a stub.
 * Near-even gaps never reach here — `paceDetail` is already null.
 */
export function ExpectedPaceMark({
  detail,
  className,
}: {
  readonly detail: LimitPaceDetail;
  readonly className?: string;
}) {
  return (
    <span
      data-pace-mark={detail.status}
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-[-10%] z-10 h-[120%] w-0.5 -translate-x-1/2 rounded-full ring-1 ring-background",
        paceMarkClass(detail),
        className,
      )}
      style={{ left: `${evenPaceRemainingPercent(detail)}%` }}
    />
  );
}

/** Icon + gap percent on the existing quota line. Tooltip has the full phrase. */
export function PaceReadout({ detail }: { readonly detail: LimitPaceDetail }) {
  const readout = formatAllowancePace(detail);
  const Icon = detail.status === "deficit" ? TrendingUpIcon : TrendingDownIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-pace-readout=""
            role="img"
            aria-label={readout.explanation}
            tabIndex={0}
            className="inline-flex items-center gap-0.5 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        }
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="tabular-nums">{readout.percent}</span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72 text-xs">
        {readout.explanation}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * One window as a full-width bar from the moment it opened to its reset.
 * The fill is the share of quota left. A green or red pill sits at even
 * pace when reserve or deficit is large enough to show.
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
  const detail = paceDetail(window, now);
  const resetsIn = formatResetsIn(window, now);
  const resetsAt = window.resetsAt
    ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)
    : null;
  const pace = detail ? formatAllowancePace(detail).marker : null;
  const summary = `${window.label}: ${remaining}% left${pace ? `, ${pace}` : ""}${
    resetsIn ? `, ${resetsIn}` : ""
  }`;

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
        <div className="absolute inset-x-0 inset-y-1.5">
          <div className="relative h-full">
            <div className="absolute inset-0 overflow-hidden rounded-full bg-muted">
              {remaining > 0 ? (
                <div
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${remaining}%`, backgroundColor: color }}
                />
              ) : null}
            </div>
            {detail ? <ExpectedPaceMark detail={detail} /> : null}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72 text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {remaining}% left{pace ? ` · ${pace}` : ""}
          </span>
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
          : "grid grid-cols-[11rem_minmax(0,1fr)_minmax(7rem,auto)] gap-x-4 gap-y-1"
      }
    >
      {windows.map((window) => {
        const detail = paceDetail(window, now);
        const resetsIn = formatResetsIn(window, now);
        return (
          <Fragment key={window.id}>
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground">{window.label}</span>
              <span className="ms-auto flex shrink-0 items-center gap-1.5 font-medium text-foreground tabular-nums">
                {remainingPercent(window)}% left
                {detail ? <PaceReadout detail={detail} /> : null}
              </span>
            </span>
            <WindowBar color={color} window={window} now={now} />
            <span className="shrink-0 self-center text-xs text-muted-foreground tabular-nums whitespace-nowrap">
              {resetsIn ?? ""}
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
export function useResetCredit(
  environmentId: EnvironmentId,
  input: ProviderConsumeResetCreditInput,
) {
  const consume = useAtomCommand(serverEnvironment.consumeResetCredit, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const redeem = async () => {
    setConfirming(false);
    setBusy(true);
    setStatus(null);
    const result = await consume({ environmentId, input });
    setBusy(false);
    if (result._tag === "Success") {
      setStatus(result.value.warning ?? OUTCOME_TEXT[result.value.outcome]);
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
  input,
  credits,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: ProviderConsumeResetCreditInput;
  readonly credits: ServerProviderResetCredits;
  readonly now: number;
}) {
  const { confirming, setConfirming, busy, status, redeem } = useResetCredit(environmentId, input);
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
 * pooled per provider. The page advances `now` on explicit refresh rather than
 * ticking: a live clock would repaint the page for no decision-changing gain.
 */
export function UsageLimitsSection({
  selectedEnvironmentIds,
  now,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly now: number;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const selected =
    selectedEnvironmentIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id)));
  return <UsageLimitsPooled presentations={selected} now={now} />;
}
