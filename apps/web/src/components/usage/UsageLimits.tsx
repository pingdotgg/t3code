import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderConsumeResetCreditOutcome,
  ProviderConsumeResetCreditInput,
  ServerProvider,
  ServerProviderResetCredits,
  ServerProviderUsageWindow,
  UsageProviderKind,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import { resetCreditFailureText } from "@t3tools/client-runtime/state/usage";
import {
  type LimitPace,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
  type ResetCreditChoice,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { Fragment, useLayoutEffect, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { observeResize } from "../../lib/observeResize";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentScope, readEnvironmentScope } from "../../state/session";
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
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { formatResetsIn, resetCreditChoices } from "@t3tools/shared/usageLimitsCopy";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

const PACE: Record<LimitPace, { readonly label: string; readonly icon: typeof GaugeIcon }> = {
  ahead: {
    label: msg("Ahead of pace: spending faster than the window elapses"),
    icon: TrendingUpIcon,
  },
  on: { label: msg("On pace with the window"), icon: GaugeIcon },
  under: {
    label: msg("Under pace: headroom left for the rest of the window"),
    icon: TrendingDownIcon,
  },
};

export function barColor(driver: ServerProvider["driver"]): string {
  const presentation = Object.values(PROVIDER_PRESENTATION).find(
    (entry) => entry.driverKind === driver,
  );
  return presentation?.color ?? "var(--foreground)";
}

export function PaceIcon({ pace }: { readonly pace: LimitPace }) {
  const Icon = PACE[pace].icon;
  const m = useMessages();
  return (
    <SharedTooltipTrigger
      render={
        <span
          role="img"
          aria-label={m(PACE[pace].label)}
          className="inline-flex text-muted-foreground"
        />
      }
      label={m(PACE[pace].label)}
    >
      <Icon className="size-3.5" aria-hidden />
    </SharedTooltipTrigger>
  );
}

// The tick sits in a transparent gap cut from the bar, clamped so it stays inside at 0% and 100%.
// The gap is a clip-path slot rather than a mask: a mask composites its layer and re-antialiases
// the bar's rounded ends, and the polygon reaches 1px past the box so only the slot edges clip.
function paceMarkStyles(timeLeft: number | null) {
  if (timeLeft === null) return null;
  const at = `clamp(3px, ${timeLeft}%, calc(100% - 3px))`;
  const [left, right] = [`calc(${at} - 3px)`, `calc(${at} + 3px)`];
  const [near, far] = ["-1px", "calc(100% + 1px)"];
  return {
    tick: { left: at },
    gap: {
      clipPath: `polygon(${near} ${near}, ${left} ${near}, ${left} ${far}, ${right} ${far}, ${right} ${near}, ${far} ${near}, ${far} ${far}, ${near} ${far})`,
    },
    // For a track painted on an element that also draws focus rings, which a clip would cut.
    gappedTrack: {
      backgroundColor: "transparent",
      backgroundImage: `linear-gradient(to right, var(--color-muted) ${left}, transparent ${left}, transparent ${right}, var(--color-muted) ${right})`,
    },
  };
}

/**
 * Pace mark styles for the bar given the returned ref. Below 6px there is no room for the gap
 * and tick, so the bar draws neither, as the mobile bars do.
 */
export function usePaceMark(timeLeft: number | null) {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const [roomy, setRoomy] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the bar DOM width before paint and remeasures through a ResizeObserver
  useLayoutEffect(() => {
    if (!bar) return;
    const measure = () => setRoomy(bar.getBoundingClientRect().width >= 6);
    measure();
    return observeResize(bar, measure);
  }, [bar]);
  return [setBar, roomy ? paceMarkStyles(timeLeft) : null] as const;
}

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
  const gt = useGT();
  const m = useMessages();
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const [barRef, paceMark] = usePaceMark(timeLeft);
  const resetsIn = formatResetsIn(window, now, m);
  const resetsAt = window.resetsAt
    ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m)
    : null;
  const label = window.label;
  const summary =
    timeLeft === null
      ? resetsIn
        ? gt("{label}: {remaining}% left, {resetsIn}", { label, remaining, resetsIn })
        : gt("{label}: {remaining}% left", { label, remaining })
      : resetsIn
        ? gt("{label}: {remaining}% left, {timeLeft}% of the window left, {resetsIn}", {
            label,
            remaining,
            timeLeft,
            resetsIn,
          })
        : gt("{label}: {remaining}% left, {timeLeft}% of the window left", {
            label,
            remaining,
            timeLeft,
          });

  return (
    <SharedTooltipTrigger
      render={
        <div
          ref={barRef}
          role="img"
          aria-label={summary}
          tabIndex={0}
          className="relative h-6 cursor-default rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
      }
      label={
        <>
          <div className="flex flex-col gap-0.5">
            <span className="text-foreground">
              {timeLeft !== null
                ? gt("{remaining}% left · {timeLeft}% of the window left", { remaining, timeLeft })
                : gt("{remaining}% left", { remaining })}
            </span>
            {timeLeft !== null ? (
              <span className="text-muted-foreground">
                <T>The line is where even spending would be.</T>
              </span>
            ) : null}
            {resetsAt ? (
              <span className="text-muted-foreground">
                {resetsIn
                  ? gt("Resets {resetsAt} · {resetsIn}", { resetsAt, resetsIn })
                  : gt("Resets {resetsAt}", { resetsAt })}
              </span>
            ) : null}
          </div>
        </>
      }
    >
      {/* Clip both layers so the gap exposes even a translucent composer surface. */}
      <div className="absolute inset-0" style={paceMark?.gap}>
        <div className="absolute inset-x-0 inset-y-1.5 rounded-full bg-muted" />
        {remaining > 0 ? (
          <div
            className="absolute inset-y-1.5 left-0 rounded-full"
            style={{ width: `${remaining}%`, backgroundColor: color }}
          />
        ) : null}
      </div>
      {paceMark ? (
        <span
          aria-hidden
          className="absolute inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={paceMark.tick}
        />
      ) : null}
    </SharedTooltipTrigger>
  );
}

export function LimitWindows({
  driver,
  accentColor,
  windows,
  now,
  compact = false,
}: {
  readonly driver: ServerProvider["driver"];
  readonly accentColor?: string | undefined;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly now: number;
  readonly compact?: boolean;
}) {
  const color = normalizeProviderAccentColor(accentColor) ?? barColor(driver);
  const gt = useGT();
  const m = useMessages();
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
        const resetsIn = formatResetsIn(window, now, m);
        return (
          <Fragment key={window.id}>
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground">{window.label}</span>
              <span className="ms-auto shrink-0 font-medium text-foreground tabular-nums">
                {gt("{remaining}% left", { remaining: remainingPercent(window) })}
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
  reset: msg("Reset applied. Your windows have cleared."),
  nothingToReset: msg("Nothing to reset right now."),
  noCredit: msg("No reset credit left."),
  alreadyRedeemed: msg("That credit was already redeemed."),
};

export function useResetCredit(environmentId: EnvironmentId) {
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const consume = useAtomCommand(serverEnvironment.consumeResetCredit, { reportFailure: false });
  const m = useMessages();
  // Kept after close so the dialog's text survives its exit animation.
  const [choice, setChoice] = useState<ResetCreditChoice | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const redeem = async () => {
    setConfirming(false);
    if (!choice || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    setBusy(true);
    setStatus(null);
    const result = await consume({ environmentId, input: choice.input });
    setBusy(false);
    if (result._tag === "Success") {
      setStatus(result.value.warning ?? m(OUTCOME_TEXT[result.value.outcome]));
      return;
    }
    setStatus(resetCreditFailureText(result, m));
  };

  const confirm = (next: ResetCreditChoice) => {
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    setChoice(next);
    setConfirming(true);
  };

  return { canManageProviders, choice, confirming, setConfirming, confirm, busy, status, redeem };
}

/** Require confirmation because redemption spends credits. Mount outside popovers, which stack above
 * dialogs and unmount on close. */
export function ResetCreditDialog({
  open,
  onOpenChange,
  choice,
  onConfirm,
  disabled = false,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly choice: ResetCreditChoice | null;
  readonly onConfirm: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <T>Use a reset credit?</T>
          </AlertDialogTitle>
          <AlertDialogDescription>{choice?.confirmDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button disabled={disabled} onClick={onConfirm}>
            <T>Use credit</T>
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

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
  const { canManageProviders, choice, confirming, setConfirming, confirm, busy, status, redeem } =
    useResetCredit(environmentId);
  const gt = useGT();
  const m = useMessages();
  if (credits.availableCount === 0 && status === null) return null;
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      {resetCreditChoices(credits, input, now, false, m).map((choice) => (
        <div key={choice.key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="tabular-nums">{choice.summary}</span>
          {choice.availableCount > 0 ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !canManageProviders}
              onClick={() => confirm(choice)}
            >
              {busy ? gt("Using…") : choice.actionLabel}
            </Button>
          ) : null}
        </div>
      ))}
      {status ? <span className="text-foreground">{status}</span> : null}
      <ResetCreditDialog
        open={confirming}
        onOpenChange={setConfirming}
        choice={choice}
        onConfirm={() => void redeem()}
        disabled={!canManageProviders}
      />
    </div>
  );
}

/** Advance now only on explicit refresh to avoid page repaints from ticking. */
export function UsageLimitsSection({
  selectedEnvironmentIds,
  hiddenProviders,
  now,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly now: number;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const hiddenDrivers = new Set<ServerProvider["driver"]>(
    [...hiddenProviders].map((provider) => PROVIDER_PRESENTATION[provider].driverKind),
  );
  const isVisible = (driver: ServerProvider["driver"]) => !hiddenDrivers.has(driver);
  const selected = new Map(
    [...presentations].flatMap(([id, presentation]) => {
      if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(id)) return [];
      const config = presentation.serverConfig;
      if (hiddenDrivers.size === 0 || config === null) return [[id, presentation] as const];
      return [
        [
          id,
          {
            ...presentation,
            serverConfig: {
              ...config,
              providers: config.providers.filter((provider) => isVisible(provider.driver)),
              usageLimitSources: config.usageLimitSources?.flatMap((source) => {
                const accounts = source.accounts.filter((account) => isVisible(account.driver));
                return accounts.length === 0 && source.accounts.length > 0
                  ? []
                  : [{ ...source, accounts }];
              }),
            },
          },
        ] as const,
      ];
    }),
  );
  return <UsageLimitsPooled presentations={selected} now={now} />;
}
