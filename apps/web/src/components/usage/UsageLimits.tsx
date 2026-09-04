import {
  type EnvironmentId,
  type ProviderConsumeResetCreditOutcome,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderResetCredits,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
  UsageLimitSourceSnapshot,
  UsageProviderKind,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitSources,
  collectLimitsGroups,
  elapsedShare,
  formatDuration,
  formatResetsIn,
  limitsNotice,
  type LimitPace,
  paceOf,
  providerLimitsLabel,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
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
import { PROVIDER_PRESENTATION } from "./usageProviders";

const PACE: Record<LimitPace, { readonly label: string; readonly icon: typeof GaugeIcon }> = {
  ahead: { label: "Ahead of pace: spending faster than the window elapses", icon: TrendingUpIcon },
  on: { label: "On pace with the window", icon: GaugeIcon },
  under: { label: "Under pace: headroom left for the rest of the window", icon: TrendingDownIcon },
};

/** The series colour the cost chart uses for this driver, so the two views read as one. */
function barColor(driver: ServerProvider["driver"]): string {
  const kind: UsageProviderKind | undefined =
    driver === "codex" ? "codex" : driver === "claudeAgent" ? "claude" : undefined;
  return kind ? PROVIDER_PRESENTATION[kind].color : "var(--foreground)";
}

/** Pace as a glyph with the words on hover. */
function PaceIcon({ pace }: { readonly pace: LimitPace }) {
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
  const used = Math.max(0, Math.min(100, window.usedPercent));
  const elapsed = elapsedShare(window, now);
  const resetsIn = formatResetsIn(window, now);
  const resetsAt = window.resetsAt
    ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)
    : null;
  const summary = `${window.label}: ${Math.round(used)}% used${
    elapsed === null ? "" : `, ${Math.round(elapsed * 100)}% of the window elapsed`
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
        {used > 0 ? (
          <div
            className="absolute inset-y-1.5 left-0 rounded-full"
            style={{ width: `${used}%`, backgroundColor: color }}
          />
        ) : null}
        {elapsed !== null ? (
          <span
            aria-hidden
            className="absolute inset-y-0.5 w-px -translate-x-1/2 bg-foreground/60"
            style={{ left: `${elapsed * 100}%` }}
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72 text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {Math.round(used)}% used
            {elapsed !== null ? ` · ${Math.round(elapsed * 100)}% of the window elapsed` : ""}
          </span>
          {elapsed !== null ? (
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

/** One account's windows as rows: label and percent, bar, pace and countdown. */
function LimitWindows({
  driver,
  windows,
  now,
}: {
  readonly driver: ServerProvider["driver"];
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly now: number;
}) {
  const color = barColor(driver);
  return (
    <div className="grid grid-cols-[11rem_minmax(0,1fr)_7rem] gap-x-4 gap-y-1">
      {windows.map((window, index) => {
        // Windows that reset together show the countdown once.
        const previous = windows[index - 1];
        const sharesReset =
          previous?.resetsAt !== undefined && previous.resetsAt === window.resetsAt;
        const pace = paceOf(window, now);
        const resetsIn = formatResetsIn(window, now);
        return (
          <Fragment key={window.id}>
            <span className="flex min-w-0 items-center gap-2 text-xs">
              <span className="truncate text-muted-foreground">{window.label}</span>
              <span className="ms-auto shrink-0 font-medium text-foreground tabular-nums">
                {Math.round(window.usedPercent)}%
              </span>
            </span>
            <WindowBar color={color} window={window} now={now} />
            <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
              {pace ? <PaceIcon pace={pace} /> : null}
              <span className="ms-auto shrink-0">{sharesReset ? "" : (resetsIn ?? "")}</span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * Heading shared by local providers and source accounts: icon, driver, instance, plan,
 * and the signed-in email blurred until clicked, as provider settings do.
 */
function AccountHeading({
  driver,
  label,
  instanceLabel,
  plan,
  email,
  accentColor,
}: {
  readonly driver: ServerProvider["driver"];
  readonly label: string;
  readonly instanceLabel: string;
  readonly plan: string | undefined;
  readonly email: string | undefined;
  readonly accentColor?: string | undefined;
}) {
  return (
    <h2 className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-foreground">
      <ProviderInstanceIcon
        driverKind={driver}
        displayName={instanceLabel}
        accentColor={accentColor}
        showBadge={Boolean(accentColor)}
        indicatorBackground="var(--background)"
        className="size-5"
        iconClassName="size-4 text-foreground/80"
      />
      <span className="truncate">{label}</span>
      {instanceLabel !== label ? (
        <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
          · {instanceLabel}
        </span>
      ) : null}
      {plan ? <span className="font-normal text-muted-foreground">· {plan}</span> : null}
      {email ? (
        <RedactedSensitiveText
          value={email}
          ariaLabel="Toggle account email visibility"
          revealTooltip="Click to reveal email"
          hideTooltip="Click to hide email"
        />
      ) : null}
    </h2>
  );
}

function ProviderLimits({
  provider,
  environmentId,
  now,
}: {
  readonly provider: ServerProvider;
  readonly environmentId: EnvironmentId;
  readonly now: number;
}) {
  const limits = provider.usageLimits;
  if (!limits) return null;
  const notice = limitsNotice(limits);
  return (
    <section className="flex flex-col gap-3">
      <AccountHeading
        driver={provider.driver}
        label={getDriverOption(provider.driver)?.label ?? String(provider.driver)}
        instanceLabel={providerLimitsLabel(provider, (driver) => getDriverOption(driver)?.label)}
        plan={provider.auth.label}
        email={provider.auth.email}
        accentColor={provider.accentColor}
      />
      {notice ? (
        <span className="text-xs text-muted-foreground">{notice}</span>
      ) : (
        <LimitWindows driver={provider.driver} windows={limits.windows} now={now} />
      )}
      {limits.resetCredits ? (
        <ResetCredits
          environmentId={environmentId}
          instanceId={provider.instanceId}
          credits={limits.resetCredits}
          now={now}
        />
      ) : null}
    </section>
  );
}

const OUTCOME_TEXT: Record<ProviderConsumeResetCreditOutcome, string> = {
  reset: "Reset applied. Your windows have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
};

/**
 * Banked reset credits with a confirmed redeem action. Redeeming spends a
 * credit the provider granted the user, so it never fires on a bare click.
 */
function ResetCredits({
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
  const consume = useAtomCommand(serverEnvironment.consumeResetCredit, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  if (credits.availableCount === 0 && status === null) return null;

  const expiresIn = credits.nextExpiresAt
    ? formatDuration(Date.parse(credits.nextExpiresAt) - now)
    : null;
  const summary =
    credits.availableCount === 0
      ? "No reset credits banked"
      : `${credits.availableCount} ${credits.availableCount === 1 ? "reset credit" : "reset credits"} banked${
          expiresIn ? ` · next expires in ${expiresIn}` : ""
        }`;

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

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="tabular-nums">{summary}</span>
      {credits.availableCount > 0 ? (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
          {busy ? "Using credit…" : "Use a reset credit"}
        </Button>
      ) : null}
      {status ? <span className="text-foreground">{status}</span> : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
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
            <Button onClick={() => void redeem()}>Use credit</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/** One account pooled by a usage-limit source, drawn like a provider row. */
function SourceAccountLimits({
  account,
  sourceKind,
  now,
}: {
  readonly account: UsageLimitSourceAccount;
  readonly sourceKind: string;
  readonly now: number;
}) {
  const notice = limitsNotice(account.usageLimits);
  return (
    <section className="flex flex-col gap-3">
      <AccountHeading
        driver={account.driver}
        label={getDriverOption(account.driver)?.label ?? String(account.driver)}
        instanceLabel={sourceKind}
        plan={account.plan}
        email={account.email}
      />
      {notice ? (
        <span className="text-xs text-muted-foreground">{notice}</span>
      ) : (
        <LimitWindows driver={account.driver} windows={account.usageLimits.windows} now={now} />
      )}
    </section>
  );
}

const SOURCE_KIND_LABEL: Record<UsageLimitSourceSnapshot["kind"], string> = {
  cliproxy: "CLI Proxy",
};

type LimitsSource = ReturnType<typeof collectLimitSources>[number];

/** Read-only accounts pooled by a configured usage source. */
function SourceLimits({ source, now }: { readonly source: LimitsSource; readonly now: number }) {
  const kind = SOURCE_KIND_LABEL[source.kind];
  return (
    <div className="flex flex-col gap-6">
      {source.error ? (
        <span className="text-xs text-muted-foreground">{source.error}</span>
      ) : source.accounts.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          {source.hiddenAccountCount > 0
            ? "All accounts are shown by connected providers."
            : "No accounts reported."}
        </span>
      ) : (
        source.accounts.map((account) => (
          <SourceAccountLimits key={account.id} account={account} sourceKind={kind} now={now} />
        ))
      )}
    </div>
  );
}

/**
 * Subscription quota windows from every connected environment's providers.
 * Countdowns anchor to render time rather than ticking: a live clock would
 * repaint the page every minute for no decision-changing gain.
 */
export function UsageLimitsSection() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const groups = collectLimitsGroups(presentations);
  const sources = collectLimitSources(presentations);
  // Anchored once per mount on purpose: countdowns must not tick (see below).
  const [now] = useState(() => Date.now());

  return (
    <div className="flex flex-col gap-8">
      {groups.length === 0 && sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on a connected environment reports subscription limits.
        </p>
      ) : null}
      {sources.map((source) => (
        <SourceLimits key={source.key} source={source} now={now} />
      ))}
      {groups.map((group) => (
        <div key={group.environmentId} className="flex flex-col gap-6">
          {group.environmentLabel ? (
            <h2 className="text-xs tracking-wide text-muted-foreground uppercase">
              {group.environmentLabel}
            </h2>
          ) : null}
          {group.providers.map((provider) => (
            <ProviderLimits
              key={provider.instanceId}
              provider={provider}
              environmentId={group.environmentId}
              now={now}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
