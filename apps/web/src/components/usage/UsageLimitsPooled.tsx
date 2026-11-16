import {
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatResetsIn,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  paceRemainingPercent,
  remainingPercent,
  type ResetCreditChoice,
  resetCreditChoices,
} from "@t3tools/shared/usageLimits";
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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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
  return (
    <span
      role="img"
      aria-label={`Account ${accountInitials(email)}`}
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
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsIn = formatResetsIn(window, now);
  const where =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label).join(", ")
      : account.sourceLabel;
  const choices =
    redeem && account.redeem && account.limits.resetCredits?.availableCount
      ? resetCreditChoices(account.limits.resetCredits, account.redeem.input, now, true)
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
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="w-fit"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        {account.plan ? <Row label="Plan">{account.plan}</Row> : null}
        {where ? (
          <Row label={account.environments.length > 0 ? "Signed in" : "Via"}>{where}</Row>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        <Row label="Left">{remaining}%</Row>
        {window.resetsAt ? (
          <Row label="Resets">
            {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            {resetsIn ? ` · ${resetsIn.replace("resets in ", "in ")}` : ""}
          </Row>
        ) : null}
        {timeLeft !== null ? <Row label="Even pace">{timeLeft}% left by now</Row> : null}
        {reset && reset.restoresPercent > 0 ? (
          <Row label="Restores">+{reset.restoresPercent}% of pool</Row>
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
                  {redeem.busy ? "Using…" : choice.actionLabel}
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
          {redeem.busy ? "Using reset credit…" : redeem.status}
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
  const resetsIn = formatResetsIn(window, now);
  const credits = account.limits.resetCredits?.availableCount ?? 0;
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
          aria-label={`${account.displayName ?? (account.email ? accountInitials(account.email) : account.driver)}: ${remaining}% left${resetsIn ? `, ${resetsIn}` : ""}${timeLeft === null ? "" : `, ${timeLeft}% of the window left`}${credits ? `, ${credits} reset ${credits === 1 ? "credit" : "credits"} banked` : ""}`}
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
            {resetsIn?.replace("resets in ", "↻ ") ?? ""}
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
              $0 cap
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
        "group/limit-row grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-3 rounded-lg border border-border/60 bg-background p-4 @xl/limits:grid-cols-[9rem_minmax(0,1fr)_auto] @xl/limits:items-center",
        isDragging && "relative z-10 shadow-md",
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
            <span>left</span>
            {pool.pace ? <PaceIcon pace={pool.pace} /> : null}
          </span>
        </span>
        {nextRefill && pool.columns.length > 1 ? (
          <span className="text-xs font-medium text-foreground tabular-nums">
            ↻ +{nextRefill.restoresPercent}%
          </span>
        ) : null}
      </div>
      <div className="col-start-2 row-start-1 @xl/limits:col-start-3">{controls}</div>
      <div className="col-span-2 min-w-0 @xl/limits:col-span-1 @xl/limits:col-start-2 @xl/limits:row-start-1">
        <PoolBar pool={pool} color={color} now={now} />
      </div>
      {description ? (
        <p className="col-span-full text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

function PoolSection({
  pool,
  windows,
  now,
  layout,
  onChange,
}: {
  readonly pool: LimitPool;
  readonly windows: readonly LimitPoolWindow[];
  readonly now: number;
  readonly layout: UsageLimitLayout;
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
  const hidden = layout.hiddenProviders.includes(pool.driver);
  const collapsed = layout.collapsedProviders.includes(pool.driver);
  return (
    <Collapsible
      open={!hidden && !collapsed}
      onOpenChange={(open) =>
        onChange((current) => ({
          ...current,
          collapsedProviders: open
            ? current.collapsedProviders.filter((driver) => driver !== pool.driver)
            : [...current.collapsedProviders, pool.driver],
        }))
      }
      render={
        <section
          ref={setNodeRef}
          style={{
            transform: CSS.Translate.toString(transform),
            transition: transition,
          }}
          className={cn(
            "@container/limits flex flex-col gap-3",
            isDragging && "relative z-10 rounded-lg bg-background shadow-md",
          )}
        />
      }
    >
      <div className="group/limit-row flex items-center gap-2">
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
        <UsageLimitLayoutControls
          label={label}
          attributes={attributes}
          listeners={listeners}
          handleRef={setActivatorNodeRef}
          isDragging={isDragging}
          hidden={hidden}
          onToggleVisibility={() =>
            onChange((current) => ({
              ...current,
              hiddenProviders: hidden
                ? current.hiddenProviders.filter((driver) => driver !== pool.driver)
                : [...current.hiddenProviders, pool.driver],
            }))
          }
        />
        <CollapsibleTrigger
          disabled={hidden}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${label} limits`}
          render={
            <button className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default" />
          }
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 opacity-0 group-focus-within/limit-row:opacity-100 group-hover/limit-row:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100",
              !hidden && !collapsed && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
      </div>
      <CollapsiblePanel animate={false}>
        <UsageLimitSortableList
          items={windows.map((window) => limitWindowKey(pool.driver, window))}
          onReorder={(active, over) =>
            onChange((current) => ({
              ...current,
              windowOrder: moveLimitItem(
                current.windowOrder,
                windows.map((window) => limitWindowKey(pool.driver, window)),
                active,
                over,
              ),
            }))
          }
        >
          <div className="flex flex-col gap-3">
            {windows.map((window) => {
              const details =
                pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool) : undefined;
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
                  hidden={windowHidden}
                  onToggleVisibility={() =>
                    onChange((current) => ({
                      ...current,
                      hiddenWindows: windowHidden
                        ? current.hiddenWindows.filter((id) => id !== key)
                        : [...current.hiddenWindows, key],
                    }))
                  }
                />
              );
            })}
          </div>
        </UsageLimitSortableList>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function UsageLimitsPooled({
  presentations,
  now,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
}) {
  const [segmentPopover] = useState(() => PopoverCreateHandle<SegmentPayload>());
  const [showHidden, setShowHidden] = useState(false);
  const restoreButton = useRef<HTMLButtonElement | null>(null);
  const limitsRoot = useRef<HTMLDivElement | null>(null);
  const focusedBeforeChange = useRef<Element | null>(null);
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
  const hasHidden = layout.hiddenProviders.length > 0 || layout.hiddenWindows.length > 0;
  const hasLayout = Object.values(layout).some((items) => items.length > 0);
  const shownPools = showHidden ? arrangedPools : visiblePools;
  const notices = collectLimitNotices(presentations);
  const externalLinks = collectExternalUsageLinks(presentations);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Hand off focus after an action removes its control.
  useLayoutEffect(() => {
    if (focusedBeforeChange.current && !focusedBeforeChange.current.isConnected) {
      const target =
        restoreButton.current ??
        limitsRoot.current?.querySelector<HTMLButtonElement>("button[aria-expanded]") ??
        limitsRoot.current;
      target?.focus();
    }
    focusedBeforeChange.current = null;
  });
  return (
    <div ref={limitsRoot} tabIndex={-1} className="flex flex-col gap-8 outline-none">
      {pools.length > 0 && visiblePools.length === 0 && !showHidden ? (
        <p className="text-sm text-muted-foreground">All limits are hidden.</p>
      ) : null}
      {pools.length === 0 && notices.length === 0 && externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
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
                onChange={(update) => {
                  focusedBeforeChange.current = document.activeElement;
                  setLayout(update);
                }}
              />
            ))}
          </div>
        </UsageLimitSortableList>
      </SegmentPopoverContext>
      {hasLayout || showHidden ? (
        <div className="flex flex-wrap items-center gap-2">
          {hasHidden || showHidden ? (
            <Button
              ref={restoreButton}
              variant="ghost-muted"
              size="sm"
              aria-pressed={showHidden}
              onClick={() => {
                focusedBeforeChange.current = document.activeElement;
                setShowHidden(!showHidden);
              }}
            >
              {showHidden ? "Hide hidden limits" : "Show hidden limits"}
            </Button>
          ) : null}
          <Button
            variant="ghost-muted"
            size="sm"
            onClick={() => {
              focusedBeforeChange.current = document.activeElement;
              setLayout(DEFAULT_LIMIT_LAYOUT);
              setShowHidden(false);
            }}
          >
            Reset layout
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
                  View usage in ChatGPT with your connected account.
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
            Manage usage
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
