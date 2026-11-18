import {
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  paceRemainingPercent,
  remainingPercent,
  type ResetCreditChoice,
} from "@t3tools/shared/usageLimits";
import { T, useGT, useMessages } from "gt-react";
import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import { AlertTriangleIcon, ChevronRightIcon, ExternalLinkIcon, TicketIcon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ensureLocalApi } from "../../localApi";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { Alert, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { PaceIcon, ResetCreditDialog, barColor, usePaceMark, useResetCredit } from "./UsageLimits";
import { UsageLimitLayoutControls, UsageLimitSortableList } from "./UsageLimitLayoutControls";
import {
  DEFAULT_LIMIT_LAYOUT,
  limitWindowKey,
  moveLimitItem,
  orderLimitItems,
  USAGE_LIMIT_LAYOUT_KEY,
  UsageLimitLayoutSchema,
  type UsageLimitLayout,
} from "./usageLimitLayout";
import {
  collectExternalUsageLinks,
  collectLimitNotices,
  cursorUsageWindowDetails,
  formatResetsIn,
  resetCreditChoices,
} from "@t3tools/shared/usageLimitsCopy";

function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

function AccountChip({ email }: { readonly email: string }) {
  const hue = accountHue(email);
  const gt = useGT();
  return (
    <span
      role="img"
      aria-label={gt("Account {initials}", { initials: accountInitials(email) })}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-3xs leading-none font-semibold"
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {accountInitials(email)}
    </span>
  );
}

function AccountAvatar({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.redeem) {
    return (
      <ProviderInstanceIcon
        driverKind={account.driver}
        displayName={
          account.displayName ??
          providerClients.get(account.driver)?.label ??
          String(account.driver)
        }
        accentColor={account.accentColor}
        showBadge={Boolean(account.displayName)}
        indicatorBackground="var(--popover)"
        className={cn("size-5", className)}
        iconClassName="size-4 text-foreground/80"
      />
    );
  }
  return account.email ? <AccountChip email={account.email} /> : null;
}

function AccountName({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.displayName) return <span className={className}>{account.displayName}</span>;
  if (account.email) {
    return (
      <span className={cn("inline-flex min-w-0 items-center", className)}>
        <AccountChip email={account.email} />
      </span>
    );
  }
  return (
    <span className={className}>
      {providerClients.get(account.driver)?.label ?? String(account.driver)}
    </span>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

function SegmentPopover({
  account,
  window,
  reset,
  now,
  redeem,
  onRedeem,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  readonly redeem: ReturnType<typeof useResetCredit> | null;
  readonly onRedeem: (choice: ResetCreditChoice) => void;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const gt = useGT();
  const m = useMessages();
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsIn = formatResetsIn(window, now, m, "in");
  const where =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label).join(", ")
      : account.sourceLabel;
  const choices =
    redeem && account.redeem && account.limits.resetCredits?.availableCount
      ? resetCreditChoices(account.limits.resetCredits, account.redeem.input, now, true, m)
      : [];
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AccountAvatar account={account} />
          <span className="truncate">
            {account.displayName ?? providerClients.get(account.driver)?.label ?? account.driver}
          </span>
        </span>
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel={gt("Toggle account email visibility")}
            revealTooltip={gt("Click to reveal email")}
            hideTooltip={gt("Click to hide email")}
            className="w-fit"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        {account.plan ? (
          <Row label={gt("Plan", { $context: "subscription plan" })}>{account.plan}</Row>
        ) : null}
        {where ? (
          <Row
            label={
              account.environments.length > 0
                ? gt("Signed in")
                : gt("Via", { $context: "signed in through a source" })
            }
          >
            {where}
          </Row>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        <Row label={gt("Left", { $context: "remaining usage" })}>{remaining}%</Row>
        {window.resetsAt ? (
          <Row label={gt("Resets", { $context: "when the usage window resets" })}>
            {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m)}
            {resetsIn ? ` · ${resetsIn}` : ""}
          </Row>
        ) : null}
        {timeLeft !== null ? (
          <Row label={gt("Even pace")}>{gt("{timeLeft}% left by now", { timeLeft })}</Row>
        ) : null}
        {reset && reset.restoresPercent > 0 ? (
          <Row label={gt("Restores", { $context: "a reset credit restores part of the pool" })}>
            {gt("+{percent}% of pool", { percent: reset.restoresPercent })}
          </Row>
        ) : null}
      </div>
      {choices.length > 0 && redeem ? (
        <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2.5 text-muted-foreground">
          {choices.map((choice) => (
            <span key={choice.key} className="flex items-center gap-3">
              <span className="tabular-nums">{choice.summary}</span>
              {choice.availableCount > 0 ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={redeem.busy || !redeem.canManageProviders}
                  className="ms-auto"
                  onClick={() => onRedeem(choice)}
                >
                  {redeem.busy ? gt("Using…") : choice.actionLabel}
                </Button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Every segment on the page shares one popover, so hovering or clicking another
 * segment moves it instead of opening a second one. The payload is the segment
 * it currently describes.
 */
type SegmentPayload = Omit<Parameters<typeof SegmentPopover>[0], "now" | "onRedeem">;
const SegmentPopoverContext = createContext<ReturnType<
  typeof PopoverCreateHandle<SegmentPayload>
> | null>(null);

function ActiveSegmentPopover({
  handle,
  actions,
  payload,
  pools,
  now,
}: {
  readonly handle: ReturnType<typeof PopoverCreateHandle<SegmentPayload>>;
  readonly actions: RefObject<PopoverPrimitive.Root.Actions | null>;
  readonly payload: SegmentPayload;
  readonly pools: readonly LimitPool[];
  readonly now: number;
}) {
  const available = pools.some((pool) =>
    displayLimitWindows(pool).some((window) =>
      window.members.some(
        (member) =>
          member.account.key === payload.account.key &&
          member.window.id === payload.window.id &&
          member.window.kind === payload.window.kind &&
          Boolean(member.account.redeem) === Boolean(payload.redeem),
      ),
    ),
  );
  // The trigger is gone, so the popup has nothing to anchor to: an exit transition would
  // slide it to the viewport origin. Unmount it outright, which also clears Base UI's
  // active-trigger bookkeeping so the segment can open again when it comes back.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the popover handle and unmounts the Base UI popup before paint when its trigger is gone
  useLayoutEffect(() => {
    if (available) return;
    handle.close();
    actions.current?.unmount();
  }, [available, handle, actions]);
  return (
    <PopoverPopup side="top" sideOffset={6}>
      <SegmentPopover
        {...payload}
        now={now}
        onRedeem={(choice) => {
          handle.close();
          payload.redeem?.confirm(choice);
        }}
      />
    </PopoverPopup>
  );
}

/**
 * The confirm is a sibling of the popover, not a child: dialogs stack under
 * popovers, and the popover closes as the confirm opens.
 */
function PoolSegment({
  account,
  ...props
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly refillPercent: number;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly showAccountName: boolean;
}) {
  return account.redeem ? (
    <RedeemableSegment account={account} redeemAt={account.redeem} {...props} />
  ) : (
    <SegmentTriggers account={account} redeem={null} {...props} />
  );
}

function RedeemableSegment({
  redeemAt,
  ...props
}: Omit<Parameters<typeof SegmentTriggers>[0], "redeem"> & {
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
}) {
  const redeem = useResetCredit(redeemAt.environmentId);
  const gt = useGT();
  return (
    <>
      <SegmentTriggers redeem={redeem} {...props} />
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        choice={redeem.choice}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
      {/* The popover closed before the confirm, so progress and the outcome need a home outside it. */}
      {redeem.busy || redeem.status ? (
        <span role="status" className="col-span-full text-xs text-muted-foreground">
          <AccountName account={props.account} className="font-medium text-foreground" />{" "}
          {redeem.busy ? gt("Using reset credit…") : redeem.status}
        </span>
      ) : null}
    </>
  );
}

function SegmentTriggers({
  account,
  window,
  reset,
  redeem,
  refillPercent,
  color,
  now,
  index,
  showAccountName,
}: SegmentPayload & {
  readonly refillPercent: number;
  readonly color: string;
  readonly now: number;
  readonly index: number;
  readonly showAccountName: boolean;
}) {
  const popover = use(SegmentPopoverContext) ?? undefined;
  const payload: SegmentPayload = { account, window, reset, redeem };
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const [segmentRef, paceMark] = usePaceMark(timeLeft);
  const m = useMessages();
  const resetsIn = formatResetsIn(window, now, m);
  const refillIn = formatResetsIn(window, now, m, "refill");
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  const gt = useGT();
  const segmentLabel = [
    gt("{name}: {remaining}% left", {
      name:
        account.displayName ?? (account.email ? accountInitials(account.email) : account.driver),
      remaining,
    }),
    resetsIn,
    timeLeft === null ? null : gt("{timeLeft}% of the window left", { timeLeft }),
    credits
      ? gt(
          "{count, plural, one {{count} reset credit banked} other {{count} reset credits banked}}",
          { count: credits },
        )
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <PopoverTrigger
      handle={popover}
      payload={payload}
      openOnHover
      render={
        <button
          ref={segmentRef}
          type="button"
          style={{ gridColumn: index, gridRow: 1, ...paceMark?.gappedTrack }}
          aria-label={segmentLabel}
          className="relative h-8 min-w-0 cursor-pointer rounded-md bg-muted text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[popup-open]:ring-1 data-[popup-open]:ring-inset data-[popup-open]:ring-border"
        />
      }
    >
      <div aria-hidden className="absolute inset-0 overflow-hidden rounded-md">
        {/* Clipped inside the rounded clip so the bar's own corners keep their antialiasing. */}
        <div className="absolute inset-0" style={paceMark?.gap}>
          <div
            aria-hidden
            className="absolute inset-y-0 left-0 rounded-md opacity-35"
            style={{ width: `${remaining}%`, backgroundColor: color }}
          />
          {remaining < 100 && reset && refillPercent > 0 ? (
            <div
              aria-hidden
              className="absolute inset-y-0 right-0 opacity-20"
              style={{
                width: `${Math.min(100 - remaining, refillPercent)}%`,
                backgroundImage: `repeating-linear-gradient(135deg, ${color} 0 1px, transparent 1px 5px)`,
              }}
            />
          ) : null}
        </div>
      </div>
      {paceMark ? (
        <span
          aria-hidden
          className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={paceMark.tick}
        />
      ) : null}
      <div className="relative flex h-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-2 text-xs">
        {showAccountName ? (
          <AccountName account={account} className="min-w-0 truncate font-medium text-foreground" />
        ) : null}
        {/* A single-account bar repeats the headline percentage. */}
        {showAccountName ? (
          <span className="shrink-0 font-semibold text-foreground tabular-nums">{remaining}%</span>
        ) : null}
        {resetsIn || credits ? (
          <span className="ms-auto flex min-w-0 items-center gap-1.5 overflow-hidden rounded-sm bg-background/85 px-1.5 py-0.5 text-2xs whitespace-nowrap text-foreground tabular-nums">
            {refillIn ?? ""}
            {credits ? (
              <>
                {resetsIn ? (
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                ) : null}
                <span aria-hidden className="inline-flex items-center gap-0.5 font-semibold">
                  <TicketIcon className="size-3" aria-hidden />
                  {credits}
                </span>
              </>
            ) : null}
          </span>
        ) : null}
      </div>
    </PopoverTrigger>
  );
}

function PoolBar({
  pool,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  const restores = new Map(pool.resets.map((reset) => [reset.member.account.key, reset]));
  const gt = useGT();
  return (
    <div className="min-w-0">
      <div
        className="grid gap-x-1 gap-y-1"
        style={{ gridTemplateColumns: `repeat(${pool.columns.length}, minmax(0, 1fr))` }}
      >
        {pool.columns.map((member, position) =>
          member.window ? (
            <PoolSegment
              key={member.account.key}
              account={member.account}
              window={member.window}
              reset={restores.get(member.account.key)}
              refillPercent={member.refillPercent}
              color={normalizeProviderAccentColor(member.account.accentColor) ?? color}
              now={now}
              index={position + 1}
              showAccountName={pool.columns.length > 1}
            />
          ) : pool.kind === "monthly" && member.account.limits.zeroSpendCap ? (
            <div
              key={member.account.key}
              style={{ gridColumn: position + 1, gridRow: 1 }}
              className="flex h-8 min-w-0 items-center justify-start gap-1.5 overflow-hidden rounded-md border border-dashed border-border px-2 text-xs whitespace-nowrap text-muted-foreground"
            >
              <AccountName account={member.account} className="inline-flex min-w-0 truncate" />
              {gt("$0 cap")}
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}

function PoolWindowCard({
  id,
  pool,
  color,
  now,
  label,
  description,
  controlLabel,
  arrangeable,
  onToggleVisibility,
  hidden,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly label?: string | null | undefined;
  readonly description?: string | undefined;
  readonly id: string;
  readonly controlLabel: string;
  readonly arrangeable: boolean;
  readonly onToggleVisibility: () => void;
  readonly hidden: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const nextRefill = pool.resets.find((reset) => reset.restoresPercent > 0);
  const style = { transform: CSS.Translate.toString(transform), transition };
  const controls = (
    <UsageLimitLayoutControls
      label={controlLabel}
      attributes={attributes}
      listeners={listeners}
      handleRef={setActivatorNodeRef}
      isDragging={isDragging}
      hidden={hidden}
      onToggleVisibility={onToggleVisibility}
    />
  );
  if (hidden) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className={cn(
          "group/limit-row flex items-center gap-3 rounded-lg border border-dashed border-border/60 bg-background py-1.5 pr-1.5 pl-4",
          isDragging && "relative z-10 shadow-md",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {label ?? pool.label}
        </span>
        {controls}
      </div>
    );
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group/limit-row relative grid items-center gap-x-6 gap-y-3 rounded-lg border border-border/60 bg-background p-4 md:grid-cols-[11rem_minmax(0,1fr)]",
        isDragging && "z-10 shadow-md",
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {label !== null ? (
          <span className="text-sm font-medium text-foreground">{label ?? pool.label}</span>
        ) : null}
        <span className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {pool.remainingPercent}%
          </span>
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <span>
              <T context="remaining usage percentage">left</T>
            </span>
            {pool.pace ? <PaceIcon pace={pool.pace} /> : null}
          </span>
        </span>
        {nextRefill && pool.columns.length > 1 ? (
          <span className="text-xs font-medium text-foreground tabular-nums">
            ↻ +{nextRefill.restoresPercent}%
          </span>
        ) : null}
      </div>
      <div className="min-w-0">
        <PoolBar pool={pool} color={color} now={now} />
      </div>
      {description ? (
        <p className="text-xs text-muted-foreground md:col-span-2">{description}</p>
      ) : null}
      {arrangeable ? (
        <div className="pointer-events-none absolute -top-3.5 right-3 z-10">{controls}</div>
      ) : null}
    </div>
  );
}

const PAGE_SCOPE = "page";

function HiddenLimitsToggle({
  scope,
  count,
  revealed,
  onToggle,
}: {
  readonly scope: string;
  readonly count: number;
  readonly revealed: boolean;
  readonly onToggle: () => void;
}) {
  const gt = useGT();
  if (count === 0) return null;
  return (
    <Button
      variant="ghost-muted"
      size="xs"
      data-hidden-toggle={scope}
      aria-expanded={revealed}
      onClick={onToggle}
    >
      {gt("{count, plural, one {{count} item hidden} other {{count} items hidden}}", { count })}
      <ChevronRightIcon aria-hidden className={cn(revealed && "rotate-90")} />
    </Button>
  );
}

function PoolSection({
  pool,
  windows,
  now,
  layout,
  revealed,
  onReveal,
  onHide,
  onChange,
}: {
  readonly pool: LimitPool;
  readonly windows: readonly LimitPoolWindow[];
  readonly now: number;
  readonly layout: UsageLimitLayout;
  readonly revealed: boolean;
  readonly onReveal: (revealed: boolean) => void;
  readonly onHide: () => void;
  readonly onChange: (update: (current: UsageLimitLayout) => UsageLimitLayout) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: pool.driver });
  const color = barColor(pool.driver);
  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const gt = useGT();
  const m = useMessages();
  const hidden = layout.hiddenProviders.includes(pool.driver);
  const collapsed = layout.collapsedProviders.includes(pool.driver);
  const keys = windows.map((window) => limitWindowKey(pool.driver, window));
  const hiddenCount = keys.filter((key) => layout.hiddenWindows.includes(key)).length;
  const showHiddenCount = !collapsed && hiddenCount > 0;
  const shownWindows = revealed
    ? windows
    : windows.filter(
        (window) => !layout.hiddenWindows.includes(limitWindowKey(pool.driver, window)),
      );
  return (
    <section
      ref={setNodeRef}
      data-limit-scope={pool.driver}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex flex-col gap-3",
        isDragging && "relative z-10 rounded-lg bg-background shadow-md",
      )}
    >
      <div className="group/limit-row relative flex min-h-6 items-center gap-2">
        <h2
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 text-sm font-medium",
            hidden ? "text-muted-foreground opacity-60" : "text-foreground",
          )}
        >
          <ProviderInstanceIcon
            driverKind={pool.driver}
            displayName={label}
            indicatorBackground="var(--background)"
            className="size-5"
            iconClassName="size-4 text-foreground/80"
          />
          <span className="truncate">{label}</span>
        </h2>
        <div className="relative flex shrink-0 items-center">
          <div
            className={cn(
              "pointer-events-none absolute top-1/2 right-full z-10 -translate-y-1/2",
              showHiddenCount && "mr-1",
            )}
          >
            <UsageLimitLayoutControls
              label={label}
              attributes={attributes}
              listeners={listeners}
              handleRef={setActivatorNodeRef}
              isDragging={isDragging}
              hidden={hidden}
              pinned={collapsed}
              onToggleVisibility={() => {
                if (!hidden) onHide();
                onChange((current) => ({
                  ...current,
                  hiddenProviders: hidden
                    ? current.hiddenProviders.filter((driver) => driver !== pool.driver)
                    : [...current.hiddenProviders, pool.driver],
                }));
              }}
            >
              {
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  aria-label={
                    collapsed
                      ? gt("Expand {label} limits", { label })
                      : gt("Collapse {label} limits", { label })
                  }
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() =>
                    onChange((current) => ({
                      ...current,
                      collapsedProviders: collapsed
                        ? current.collapsedProviders.filter((driver) => driver !== pool.driver)
                        : [...current.collapsedProviders, pool.driver],
                    }))
                  }
                >
                  <ChevronRightIcon
                    aria-hidden
                    className={cn("size-4", !collapsed && "rotate-90")}
                  />
                </button>
              }
            </UsageLimitLayoutControls>
          </div>
          {showHiddenCount ? (
            <HiddenLimitsToggle
              scope={pool.driver}
              count={hiddenCount}
              revealed={revealed}
              onToggle={() => onReveal(!revealed)}
            />
          ) : null}
        </div>
      </div>
      {collapsed || shownWindows.length === 0 ? null : (
        <UsageLimitSortableList
          items={shownWindows.map((window) => limitWindowKey(pool.driver, window))}
          onReorder={(active, over) =>
            onChange((current) => ({
              ...current,
              windowOrder: moveLimitItem(current.windowOrder, keys, active, over),
            }))
          }
        >
          <div className={cn("flex flex-col gap-3", hidden && "opacity-60")}>
            {shownWindows.map((window) => {
              const details =
                pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool, m) : undefined;
              const key = limitWindowKey(pool.driver, window);
              const windowHidden = layout.hiddenWindows.includes(key);
              return (
                <PoolWindowCard
                  key={key}
                  id={key}
                  pool={window}
                  color={color}
                  now={now}
                  label={details?.label}
                  description={details?.description}
                  controlLabel={`${label} ${details?.label ?? window.label}`}
                  arrangeable={windows.length > 1}
                  hidden={windowHidden}
                  onToggleVisibility={() => {
                    if (!windowHidden) onReveal(false);
                    onChange((current) => ({
                      ...current,
                      hiddenWindows: windowHidden
                        ? current.hiddenWindows.filter((id) => id !== key)
                        : [...current.hiddenWindows, key],
                    }));
                  }}
                />
              );
            })}
          </div>
        </UsageLimitSortableList>
      )}
    </section>
  );
}

export function UsageLimitsPooled({
  presentations,
  now,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const [segmentPopover] = useState(() => PopoverCreateHandle<SegmentPayload>());
  const [revealed, setRevealed] = useState<readonly string[]>([]);
  const limitsRoot = useRef<HTMLDivElement | null>(null);
  const focusedBeforeChange = useRef<{ element: Element; scope: string | null } | null>(null);
  const [layout, setLayout] = useLocalStorage(
    USAGE_LIMIT_LAYOUT_KEY,
    DEFAULT_LIMIT_LAYOUT,
    UsageLimitLayoutSchema,
  );
  const segmentPopoverActions = useRef<PopoverPrimitive.Root.Actions | null>(null);
  const pools = orderLimitItems(
    collectLimitPools(collectLimitAccounts(presentations), now),
    layout.providerOrder,
    (pool) => pool.driver,
  );
  const arrangedPools = pools.map((pool) => ({
    pool,
    windows: orderLimitItems(displayLimitWindows(pool), layout.windowOrder, (window) =>
      limitWindowKey(pool.driver, window),
    ),
  }));
  const visiblePools = arrangedPools
    .map(({ pool, windows }) => ({
      pool,
      windows: windows.filter(
        (window) => !layout.hiddenWindows.includes(limitWindowKey(pool.driver, window)),
      ),
    }))
    .filter(
      ({ pool, windows }) => !layout.hiddenProviders.includes(pool.driver) && windows.length > 0,
    );
  const hiddenProviderCount = pools.filter((pool) =>
    layout.hiddenProviders.includes(pool.driver),
  ).length;
  const providersRevealed = revealed.includes(PAGE_SCOPE);
  const shownPools = providersRevealed
    ? arrangedPools
    : arrangedPools.filter(({ pool }) => !layout.hiddenProviders.includes(pool.driver));
  const hasLayout = Object.values(layout).some((items) => items.length > 0);
  const notices = collectLimitNotices(presentations, m);
  const externalLinks = collectExternalUsageLinks(presentations, m);
  const reveal = (scope: string, next: boolean) =>
    setRevealed((current) =>
      next ? [...current, scope] : current.filter((revealedScope) => revealedScope !== scope),
    );
  const rememberFocus = () => {
    const element = document.activeElement;
    focusedBeforeChange.current = element
      ? {
          element,
          scope: element.closest("[data-limit-scope]")?.getAttribute("data-limit-scope") ?? null,
        }
      : null;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Hand off focus after an action removes its control.
  useLayoutEffect(() => {
    const before = focusedBeforeChange.current;
    focusedBeforeChange.current = null;
    if (!before || before.element.isConnected) return;
    const root = limitsRoot.current;
    const section = before.scope
      ? root?.querySelector(`[data-limit-scope="${globalThis.CSS.escape(before.scope)}"]`)
      : null;
    const target =
      section?.querySelector<HTMLElement>("[data-hidden-toggle]") ??
      section?.querySelector<HTMLElement>("button[aria-expanded]") ??
      root?.querySelector<HTMLElement>(`[data-hidden-toggle="${PAGE_SCOPE}"]`) ??
      root?.querySelector<HTMLElement>("button[aria-expanded]") ??
      root;
    target?.focus();
  });
  return (
    <div ref={limitsRoot} tabIndex={-1} className="flex flex-col gap-8 outline-none">
      {hiddenProviderCount > 0 ? (
        <div className="-mb-5 flex justify-end">
          <HiddenLimitsToggle
            scope={PAGE_SCOPE}
            count={hiddenProviderCount}
            revealed={providersRevealed}
            onToggle={() => {
              rememberFocus();
              reveal(PAGE_SCOPE, !providersRevealed);
            }}
          />
        </div>
      ) : null}
      {pools.length === 0 && notices.length === 0 && externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <T>No provider on the selected environments reports subscription limits.</T>
        </p>
      ) : null}
      <SegmentPopoverContext value={segmentPopover}>
        <UsageLimitSortableList
          items={shownPools.map(({ pool }) => pool.driver)}
          onReorder={(active, over) =>
            setLayout((current) => ({
              ...current,
              providerOrder: moveLimitItem(
                current.providerOrder,
                pools.map((pool) => pool.driver),
                active,
                over,
              ),
            }))
          }
        >
          <div className="flex flex-col gap-8 empty:hidden">
            {shownPools.map(({ pool, windows }) => (
              <PoolSection
                key={pool.driver}
                pool={pool}
                windows={windows}
                now={now}
                layout={layout}
                revealed={revealed.includes(pool.driver)}
                onReveal={(next) => {
                  rememberFocus();
                  reveal(pool.driver, next);
                }}
                onHide={() => reveal(PAGE_SCOPE, false)}
                onChange={(update) => {
                  rememberFocus();
                  setLayout(update);
                }}
              />
            ))}
          </div>
        </UsageLimitSortableList>
      </SegmentPopoverContext>
      {hasLayout ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost-muted"
            size="sm"
            onClick={() => {
              rememberFocus();
              setLayout(DEFAULT_LIMIT_LAYOUT);
              setRevealed([]);
            }}
          >
            <T>Reset layout</T>
          </Button>
        </div>
      ) : null}
      <Popover handle={segmentPopover} actionsRef={segmentPopoverActions}>
        {({ payload }) =>
          payload ? (
            <ActiveSegmentPopover
              handle={segmentPopover}
              actions={segmentPopoverActions}
              payload={payload}
              pools={visiblePools
                .filter(({ pool }) => !layout.collapsedProviders.includes(pool.driver))
                .map(({ pool, windows }) => ({ ...pool, windows }))}
              now={now}
            />
          ) : null
        }
      </Popover>
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
