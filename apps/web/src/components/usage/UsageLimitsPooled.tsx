import { mFallback } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import { T, useGT, useMessages, msg } from "gt-react";
import {
  collectExternalUsageLinks,
  collectLimitNotices,
  cursorUsageWindowDetails,
  formatDuration,
  formatResetsIn,
  resetCreditChoices,
} from "@t3tools/shared/usageLimitsCopy";
import {
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
  paceRemainingPercent,
  remainingPercent,
  type ResetCreditChoice,
} from "@t3tools/shared/usageLimits";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { AlertTriangleIcon, ExternalLinkIcon, RotateCcwIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { redactedPlaceholder } from "../settings/RedactedSensitiveText";
import { Alert, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ResetCreditDialog, useResetCredit } from "./UsageLimits";

export type LimitDisplay = "left" | "used";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type Tone = "success" | "warning" | "destructive";
const TONE_BG: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

function toneOf(remaining: number): Tone {
  if (remaining >= 50) return "success";
  if (remaining >= 20) return "warning";
  return "destructive";
}

function shown(remaining: number, display: LimitDisplay): number {
  return display === "left" ? remaining : 100 - remaining;
}

function windowName(label: string): string {
  return label.replace(/^Weekly · /, "");
}

function windowNoun(kind: ServerProviderUsageWindow["kind"]): string {
  if (kind === "session") return "session";
  if (kind === "weekly") return "week";
  if (kind === "monthly") return "month";
  return "window";
}

function shortPlan(plan: string): string {
  return plan.replace(/^claude\s+/i, "").replace(/\s+subscription$/i, "");
}

function initials(account: LimitAccount): string {
  if (account.displayName) {
    const words = account.displayName.split(/\s+/).filter(Boolean);
    return words
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  }
  const [local = "", domain = ""] = (account.email ?? "").split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

function accountHue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

function untilText(
  iso: string | undefined,
  now: number,
  m: MFunctionType = mFallback,
): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? formatDuration(at - now, m) : null;
}

interface AccountCredit {
  readonly key: string;
  readonly title: string;
  readonly refills: string;
  readonly count: number;
  readonly expiresAt: string | undefined;
  /** Null when this client cannot redeem it, such as a hub that only takes its next credit. */
  readonly choice: ResetCreditChoice | null;
}

/** One entry per kind of credit, so a credit is offered in exactly one place. */
function accountCredits(
  account: LimitAccount,
  now: number,
  m: MFunctionType,
): readonly AccountCredit[] {
  const credits = account.limits.resetCredits;
  if (!credits || credits.availableCount === 0) return [];
  const choices = account.redeem
    ? resetCreditChoices(credits, account.redeem.input, now, false, m)
    : null;
  const options = credits.options?.filter((option) => option.availableCount > 0) ?? [];
  const typed = options.map((option) => ({
    key: option.creditId,
    title: option.label,
    refills: option.description,
    count: option.availableCount,
    expiresAt: option.expiresAt,
    choice: choices?.find((choice) => choice.key === option.creditId) ?? null,
  }));
  if (typed.length > 0 && !choices?.some((choice) => choice.key === "next")) return typed;
  return [
    ...typed,
    {
      key: "next",
      title: m(msg("Reset credit")),
      refills: m(msg("Clears the current limit windows.")),
      count: credits.availableCount,
      expiresAt: credits.nextExpiresAt,
      choice: choices?.[0] ?? null,
    },
  ];
}

function expiresSoon(credit: AccountCredit, now: number): boolean {
  if (!credit.expiresAt) return false;
  const at = Date.parse(credit.expiresAt);
  return Number.isFinite(at) && at - now < WEEK_MS;
}

interface AccountRowModel {
  readonly account: LimitAccount;
  readonly cells: ReadonlyArray<ServerProviderUsageWindow | null>;
  readonly credits: readonly AccountCredit[];
  /** Session and weekly are both spent; the value is when the later one resets. */
  readonly outUntil: string | null | undefined;
}

function accountRow(
  account: LimitAccount,
  windows: readonly LimitPoolWindow[],
  now: number,
  m: MFunctionType,
): AccountRowModel {
  const cells = windows.map(
    (window) => window.columns.find((column) => column.account.key === account.key)?.window ?? null,
  );
  const session = cells.find((cell) => cell?.kind === "session");
  const weekly = cells.find((cell) => cell?.kind === "weekly");
  const out =
    session && weekly && remainingPercent(session) === 0 && remainingPercent(weekly) === 0;
  const backAt = out
    ? [session.resetsAt, weekly.resetsAt]
        .filter((iso): iso is string => iso !== undefined)
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0]
    : undefined;
  return {
    account,
    cells,
    credits: accountCredits(account, now, m),
    outUntil: out ? (backAt ?? null) : undefined,
  };
}

function AccountAvatar({ account, muted = false }: { account: LimitAccount; muted?: boolean }) {
  const hue = accountHue(account.displayName ?? account.email ?? account.key);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-3xs leading-none font-semibold",
        muted && "opacity-60 grayscale",
      )}
      style={{ backgroundColor: `oklch(0.8 0.12 ${hue})`, color: `oklch(0.3 0.08 ${hue})` }}
    >
      {initials(account)}
    </span>
  );
}

function PlanBadge({ plan }: { plan: string | undefined }) {
  if (!plan) return null;
  return (
    <Badge variant="outline" size="sm">
      {shortPlan(plan)}
    </Badge>
  );
}

function accountTitle(account: LimitAccount, hideEmails: boolean): string {
  if (account.displayName) return account.displayName;
  if (account.email) return hideEmails ? redactedPlaceholder(account.email) : account.email;
  return providerClients.get(account.driver)?.label ?? String(account.driver);
}

function accountSubtitle(account: LimitAccount, hideEmails: boolean): string | null {
  if (!account.displayName || !account.email) return null;
  return hideEmails ? redactedPlaceholder(account.email) : account.email;
}

function ResetChip({
  credit,
  now,
  disabled,
  onUse,
}: {
  readonly credit: AccountCredit;
  readonly now: number;
  readonly disabled: boolean;
  readonly onUse: () => void;
}) {
  const gt = useGT();
  const kind = credit.key === "next" ? "" : `${credit.title.replace(/ reset$/i, "")} `;
  const expires = untilText(credit.expiresAt, now);
  const description = `${credit.title} · ${credit.count} left · ${credit.refills}${
    expires ? gt(" · expires in {duration}", { duration: expires }) : ""
  }`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={gt("Use {description}", { description })}
            disabled={disabled}
            onClick={onUse}
            className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-1.5 text-2xs font-medium text-foreground tabular-nums outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default disabled:opacity-50"
          />
        }
      >
        <RotateCcwIcon
          aria-hidden
          className={cn("size-3", expiresSoon(credit, now) ? "text-warning" : "text-foreground/70")}
        />
        {kind}
        {credit.count}
      </TooltipTrigger>
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}

function PaceTooltipText({
  window,
  remaining,
  timeLeft,
  display,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly remaining: number;
  readonly timeLeft: number;
  readonly display: LimitDisplay;
  readonly now: number;
}) {
  const gt = useGT();
  const resetsIn = untilText(window.resetsAt, now);
  const gap = remaining - timeLeft;
  let detail: string;
  if (remaining === 0) {
    detail = resetsIn ? `Out of usage. Back in ${resetsIn}.` : "Out of usage.";
  } else if (gap < 0) {
    detail = `Where you'd be if you spread this ${windowNoun(window.kind)} evenly. You're ${-gap}% behind, so at this rate you run out before it resets${
      resetsIn ? ` in ${resetsIn}` : ""
    }.`;
  } else {
    detail = `You're ${gap}% ahead of pace.`;
  }
  return (
    <div className="flex max-w-64 flex-col gap-0.5">
      <span className="font-medium text-foreground">
        {gt("Even pace · {percent}% {display} by now", {
          percent: shown(timeLeft, display),
          display: gt(display === "left" ? "left" : "used"),
        })}
      </span>
      <span className="text-muted-foreground">{detail}</span>
    </div>
  );
}

function Meter({
  window,
  now,
  display,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly display: LimitDisplay;
}) {
  const gt = useGT();
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const m = useMessages();
  const resetsIn = formatResetsIn(window, now, m);
  const out = remaining === 0;
  const fill = shown(remaining, display);
  const tick = timeLeft === null ? null : shown(timeLeft, display);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex shrink-0 items-baseline gap-1">
          <span className="text-sm font-semibold text-foreground tabular-nums">
            {shown(remaining, display)}%
          </span>
          <span className="text-2xs text-muted-foreground">{display}</span>
        </span>
        <span
          className={cn(
            "ms-auto min-w-0 truncate text-2xs tabular-nums",
            out ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {resetsIn ?? ""}
        </span>
      </div>
      <div
        role="img"
        aria-label={`${window.label}: ${shown(remaining, display)}% ${display}${resetsIn ? `, ${resetsIn}` : ""}`}
        className="relative h-2"
      >
        <div
          className={cn(
            "absolute inset-x-0 top-0.5 h-1 overflow-hidden rounded-full",
            out ? "bg-destructive/20" : "bg-muted",
          )}
        >
          {fill > 0 ? (
            <div
              className={cn("h-full rounded-full", TONE_BG[toneOf(remaining)])}
              style={{ width: `${fill}%` }}
            />
          ) : null}
        </div>
        {tick !== null && timeLeft !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  aria-label={gt("Even pace: {percent}% {display} by now", {
                    percent: tick,
                    display: gt(display === "left" ? "left" : "used"),
                  })}
                  className="group absolute inset-y-0 flex w-2 -translate-x-1/2 cursor-default justify-center outline-none"
                  style={{ left: `clamp(1px, ${tick}%, calc(100% - 1px))` }}
                />
              }
            >
              <span className="h-full w-0.5 rounded-full bg-foreground/70 group-hover:bg-foreground group-focus-visible:bg-foreground" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              <PaceTooltipText
                window={window}
                remaining={remaining}
                timeLeft={timeLeft}
                display={display}
                now={now}
              />
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

function AccountCard({
  row,
  windows,
  now,
  display,
  hideEmails,
  redeemDisabled,
  onUseCredit,
}: {
  readonly row: AccountRowModel;
  readonly windows: readonly LimitPoolWindow[];
  readonly now: number;
  readonly display: LimitDisplay;
  readonly hideEmails: boolean;
  readonly redeemDisabled: boolean;
  readonly onUseCredit: (credit: AccountCredit) => void;
}) {
  const gt = useGT();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const { account } = row;
  const subtitle = accountSubtitle(account, hideEmails);
  const where =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label).join(", ")
      : account.sourceLabel;
  const limitedIndex = row.cells.findIndex((cell) => cell !== null && remainingPercent(cell) === 0);
  const focusIndex = limitedIndex >= 0 ? limitedIndex : row.cells.findIndex((cell) => cell);
  const focus = focusIndex >= 0 ? row.cells[focusIndex] : null;
  const focusLabel = focusIndex >= 0 ? windowName(windows[focusIndex]!.label) : null;
  const timeLeft = focus ? paceRemainingPercent(focus, now) : null;
  const resetsIn = focus ? untilText(focus.resetsAt, now) : null;
  return (
    <div className="flex w-80 max-w-[calc(100vw-3rem)] flex-col gap-3 text-xs">
      <div className="flex min-w-0 items-center gap-2.5">
        <AccountAvatar account={account} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
            <span className="truncate">{accountTitle(account, hideEmails)}</span>
            <PlanBadge plan={account.plan} />
          </span>
          {subtitle || where ? (
            <span className="truncate text-muted-foreground">
              {[subtitle, where].filter(Boolean).join(" · ")}
            </span>
          ) : null}
        </div>
      </div>
      {focus && focusLabel ? (
        <div className="flex flex-col gap-1 border-t border-border/60 pt-3">
          <span className="mb-1 flex items-center gap-2 font-medium text-foreground">
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full", TONE_BG[toneOf(remainingPercent(focus))])}
            />
            {limitedIndex >= 0 ? gt("{window} limited", { window: focusLabel }) : focusLabel}
          </span>
          <DetailRow label={display === "left" ? gt("Left") : gt("Used")}>
            {shown(remainingPercent(focus), display)}%
          </DetailRow>
          {focus.resetsAt ? (
            <DetailRow label={limitedIndex >= 0 ? gt("Back") : gt("Resets")}>
              {formatUpcomingTimestamp(focus.resetsAt, timestampFormat, now)}
              {resetsIn ? gt(" · in {duration}", { duration: resetsIn }) : ""}
            </DetailRow>
          ) : null}
          {timeLeft !== null ? (
            <DetailRow label={gt("Even pace")}>
              {gt("{percent}% {display} by now", {
                percent: shown(timeLeft, display),
                display: gt(display === "left" ? "left" : "used"),
              })}
            </DetailRow>
          ) : null}
        </div>
      ) : null}
      {row.credits.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border/60 pt-3">
          <span className="font-medium text-foreground">
            <T>Resets</T>
          </span>
          {row.credits.map((credit) => {
            const expires = untilText(credit.expiresAt, now);
            const soon = expiresSoon(credit, now);
            return (
              <div key={credit.key} className="flex items-center gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-foreground">
                    <RotateCcwIcon
                      aria-hidden
                      className={cn("size-3", soon ? "text-warning" : "text-muted-foreground")}
                    />
                    {credit.title}
                    <span className="text-muted-foreground">
                      {gt("· {count} left", { count: credit.count })}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "text-pretty",
                      soon ? "text-warning-foreground" : "text-muted-foreground",
                    )}
                  >
                    {credit.refills}
                    {expires ? ` · expires in ${expires}` : ""}
                  </span>
                </div>
                <div className="ms-auto shrink-0">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={redeemDisabled || credit.choice === null}
                    onClick={() => onUseCredit(credit)}
                  >
                    <T>Use</T>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

type RedeemController = ReturnType<typeof useResetCredit>;

function AccountRow(props: {
  readonly row: AccountRowModel;
  readonly windows: readonly LimitPoolWindow[];
  readonly now: number;
  readonly display: LimitDisplay;
  readonly hideEmails: boolean;
  readonly provider: { readonly label: string } | null;
}) {
  return props.row.account.redeem ? (
    <RedeemableAccountRow {...props} redeemAt={props.row.account.redeem} />
  ) : (
    <AccountRowView {...props} redeem={null} onUseCredit={() => {}} />
  );
}

function RedeemableAccountRow({
  redeemAt,
  ...props
}: Parameters<typeof AccountRow>[0] & {
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
}) {
  const gt = useGT();
  const redeem = useResetCredit(redeemAt.environmentId);
  return (
    <>
      <AccountRowView
        {...props}
        redeem={redeem}
        onUseCredit={(credit) => {
          if (credit.choice) redeem.confirm(credit.choice);
        }}
      />
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        choice={redeem.choice}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
      {redeem.busy || redeem.status ? (
        <span role="status" className="px-4 pb-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {accountTitle(props.row.account, props.hideEmails)}
          </span>{" "}
          {redeem.busy ? "Using reset credit…" : redeem.status}
        </span>
      ) : null}
    </>
  );
}

function AccountRowView({
  row,
  windows,
  now,
  display,
  hideEmails,
  provider,
  redeem,
  onUseCredit,
}: Parameters<typeof AccountRow>[0] & {
  readonly redeem: RedeemController | null;
  readonly onUseCredit: (credit: AccountCredit) => void;
}) {
  const gt = useGT();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const [cardOpen, setCardOpen] = useState(false);
  const { account } = row;
  const redeemDisabled = !redeem || redeem.busy || !redeem.canManageProviders;
  const spendCredit = (credit: AccountCredit) => {
    setCardOpen(false);
    onUseCredit(credit);
  };
  const subtitle = accountSubtitle(account, hideEmails);

  const identity = (
    <Popover open={cardOpen} onOpenChange={setCardOpen}>
      <PopoverTrigger
        openOnHover
        delay={250}
        render={
          <button
            type="button"
            className="flex min-w-0 cursor-default items-center gap-2.5 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        {provider ? (
          <span className="flex shrink-0 items-center gap-2 text-sm font-medium">
            <ProviderInstanceIcon
              driverKind={account.driver}
              displayName={provider.label}
              indicatorBackground="var(--background)"
              className="size-4"
              iconClassName="size-3.5"
            />
            {provider.label}
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
          </span>
        ) : null}
        <AccountAvatar account={account} muted={row.outUntil !== undefined} />
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {accountTitle(account, hideEmails)}
            </span>
            <PlanBadge plan={account.plan} />
          </span>
          {subtitle && row.outUntil === undefined ? (
            <span className="truncate text-2xs text-muted-foreground">{subtitle}</span>
          ) : null}
        </span>
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" sideOffset={6}>
        <AccountCard
          row={row}
          windows={windows}
          now={now}
          display={display}
          hideEmails={hideEmails}
          redeemDisabled={redeemDisabled}
          onUseCredit={spendCredit}
        />
      </PopoverPopup>
    </Popover>
  );

  if (row.outUntil !== undefined) {
    const back = row.outUntil ? untilText(row.outUntil, now) : null;
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2 opacity-70">{identity}</div>
        <span className="ms-auto flex min-w-0 items-center gap-1.5 text-xs">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
          <span>
            <T>Out of usage</T>
          </span>
          {row.outUntil ? (
            <span className="truncate tabular-nums">
              {gt("· back {time}", {
                time: formatUpcomingTimestamp(row.outUntil, timestampFormat, now),
              })}
              {back ? ` (${back})` : ""}
            </span>
          ) : null}
        </span>
        {row.credits.map((credit) => (
          <ResetChip
            key={credit.key}
            credit={credit}
            now={now}
            disabled={redeemDisabled || credit.choice === null}
            onUse={() => spendCredit(credit)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-x-7 gap-y-3 px-4 py-3 @3xl/limits:grid-cols-[15rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        {identity}
        {row.credits.length > 0 ? (
          <span className="flex flex-wrap items-center gap-1 ps-7.5">
            {row.credits.map((credit) => (
              <ResetChip
                key={credit.key}
                credit={credit}
                now={now}
                disabled={redeemDisabled || credit.choice === null}
                onUse={() => spendCredit(credit)}
              />
            ))}
          </span>
        ) : null}
      </div>
      <div
        className="grid min-w-0 gap-x-7"
        style={{ gridTemplateColumns: `repeat(${windows.length}, minmax(0, 1fr))` }}
      >
        {row.cells.map((cell, index) =>
          cell ? (
            <Meter key={windows[index]!.id} window={cell} now={now} display={display} />
          ) : windows[index]!.kind === "monthly" && account.limits.zeroSpendCap ? (
            <span
              key={windows[index]!.id}
              className="flex min-w-0 items-center text-xs text-muted-foreground"
            >
              <T>$0 cap</T>
            </span>
          ) : (
            <span key={windows[index]!.id} aria-hidden />
          ),
        )}
      </div>
    </div>
  );
}

function ProviderCard({
  pool,
  now,
  display,
  hideEmails,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly display: LimitDisplay;
  readonly hideEmails: boolean;
}) {
  const m = useMessages();
  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const windows = displayLimitWindows(pool);
  const rows = pool.accounts.map((account) => accountRow(account, windows, now, m));
  const onlyRow = rows.length === 1 ? rows[0]! : null;
  const allOut = rows.every((row) => row.outUntil !== undefined);

  if (onlyRow && allOut) {
    return (
      <section aria-label={label} className="rounded-xl border border-border/50 bg-muted/30">
        <AccountRow
          row={onlyRow}
          windows={windows}
          now={now}
          display={display}
          hideEmails={hideEmails}
          provider={{ label }}
        />
      </section>
    );
  }

  return (
    <section
      aria-label={label}
      className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70"
    >
      <div className="grid min-w-0 gap-x-7 gap-y-2 bg-muted/30 px-4 py-2.5 @3xl/limits:grid-cols-[15rem_minmax(0,1fr)]">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <ProviderInstanceIcon
            driverKind={pool.driver}
            displayName={label}
            indicatorBackground="var(--background)"
            className="size-4"
            iconClassName="size-3.5"
          />
          {label}
          {rows.length > 1 ? (
            <span className="text-2xs font-normal text-muted-foreground">
              {rows.length} accounts
            </span>
          ) : null}
        </h2>
        <div
          className="grid min-w-0 gap-x-7"
          style={{ gridTemplateColumns: `repeat(${windows.length}, minmax(0, 1fr))` }}
        >
          {windows.map((window) => {
            const details =
              pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool, m) : undefined;
            return (
              <span
                key={`${window.kind}:${window.id}`}
                className="flex min-w-0 items-center gap-2 text-xs"
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    TONE_BG[toneOf(window.remainingPercent)],
                  )}
                />
                {details?.description ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="truncate text-muted-foreground" tabIndex={0} />}
                    >
                      {details.label}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{details.description}</TooltipPopup>
                  </Tooltip>
                ) : (
                  <span className="truncate text-muted-foreground">{windowName(window.label)}</span>
                )}
                <span className="ms-auto flex shrink-0 items-baseline gap-1">
                  <span className="font-semibold text-foreground tabular-nums">
                    {display === "left" ? window.remainingPercent : window.usedPercent}%
                  </span>
                  <span className="text-2xs text-muted-foreground">{display}</span>
                </span>
              </span>
            );
          })}
        </div>
      </div>
      {rows.map((row) => (
        <div
          key={row.account.key}
          className={cn("flex flex-col", row.outUntil !== undefined && "bg-muted/30")}
        >
          <AccountRow
            row={row}
            windows={windows}
            now={now}
            display={display}
            hideEmails={hideEmails}
            provider={null}
          />
        </div>
      ))}
    </section>
  );
}

export function UsageLimitsPooled({
  presentations,
  now,
  display,
  hideEmails,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
  readonly display: LimitDisplay;
  readonly hideEmails: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const notices = collectLimitNotices(presentations, m);
  const externalLinks = collectExternalUsageLinks(presentations, m);
  return (
    <div className="@container/limits flex flex-col gap-4">
      {pools.length === 0 && notices.length === 0 && externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <T>No provider on the selected environments reports subscription limits.</T>
        </p>
      ) : null}
      {pools.map((pool) => (
        <ProviderCard
          key={pool.driver}
          pool={pool}
          now={now}
          display={display}
          hideEmails={hideEmails}
        />
      ))}
      {externalLinks.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {link.url === CHATGPT_USAGE_URL ? (
              <OpenAI className="size-5 shrink-0" aria-hidden="true" />
            ) : null}
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">{link.label}</h2>
              <p className="text-xs break-words text-muted-foreground">
                {link.accounts.join(", ")}
              </p>
              {link.url === CHATGPT_USAGE_URL ? (
                <p className="text-xs text-muted-foreground">
                  <T>View usage in ChatGPT with your connected account.</T>
                </p>
              ) : link.message ? (
                <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            {gt("Manage usage")}
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}
      <LimitNotices notices={notices} />
    </div>
  );
}

function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {notices.map((notice) => (
        <AlertTitle key={notice} className="break-words">
          {notice}
        </AlertTitle>
      ))}
    </Alert>
  );
}
