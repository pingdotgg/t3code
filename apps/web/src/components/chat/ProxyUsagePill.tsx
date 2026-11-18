import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProxyLedgerSummaryStyle,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@lathe/contracts";
import { Fragment, useEffect, useState, useSyncExternalStore } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useNowMinute } from "~/hooks/useNowMinute";
import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ChevronRightIcon, FeatherIcon, XIcon } from "lucide-react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ResetCredits, type ResetCreditRedeemState } from "../usage/UsageLimits";
import { ProxyAccountIdentity } from "./ProxyAccountIdentity";
import { ProxyLoginPanel } from "./ProxyLoginPanel";
import { proxyLoginPanelAtom, proxyStatusCardOpenAtom } from "./proxyLoginRequest";
import { ProxyStatusCard } from "./ProxyStatusCard";
import { measureThreadSideCard, useThreadSideCardPlacement } from "./useThreadSideCardPlacement";
import {
  deriveProxyPill,
  resetCreditSlots,
  resetRedeemKey,
  selectProxySource,
  type ProxyAccountView,
  type ProxyPillView,
  type ProxyTone,
  type ProxyWindowGlyph,
  type ProxyWindowView,
} from "./ProxyUsagePill.logic";

const TONE_TEXT: Record<ProxyTone | "live", string> = {
  ok: "text-success-foreground",
  warn: "text-warning-foreground",
  crit: "text-error-foreground",
  muted: "text-muted-foreground",
  live: "text-info-foreground",
};

const TONE_FILL: Record<ProxyTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  crit: "bg-error",
  muted: "bg-muted-foreground/60",
};

const TONE_STROKE: Record<ProxyTone, string> = {
  ok: "var(--color-success)",
  warn: "var(--color-warning)",
  crit: "var(--color-error)",
  muted: "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)",
};
const TRACK_STROKE = "color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)";

function ring(cx: number, r: number, usedPercent: number | null, tone: ProxyTone, width: number) {
  const circumference = 2 * Math.PI * r;
  const fill = usedPercent === null ? 0 : Math.max(0, Math.min(100, usedPercent)) / 100;
  return (
    <>
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={TRACK_STROKE} strokeWidth={width} />
      {fill > 0 ? (
        <circle
          cx={cx}
          cy={cx}
          r={r}
          fill="none"
          stroke={TONE_STROKE[tone]}
          strokeWidth={width}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fill)}
        />
      ) : null}
    </>
  );
}

/**
 * The iris of an eye, the gateway's namesake, drawn as two gauges: the outer
 * ring is the serving account's session window and the inner its weekly
 * window. A window the gateway has not observed leaves its track empty.
 */
function IrisGauge({
  session,
  weekly,
  className,
}: {
  readonly session: { usedPercent: number; tone: ProxyTone } | null;
  readonly weekly: { usedPercent: number; tone: ProxyTone } | null;
  readonly className?: string;
}) {
  return (
    <svg viewBox="0 0 16 16" className={cn("size-3.5 shrink-0 -rotate-90", className)} aria-hidden>
      {ring(8, 6.4, session?.usedPercent ?? null, session?.tone ?? "muted", 1.8)}
      {ring(8, 3.4, weekly?.usedPercent ?? null, weekly?.tone ?? "muted", 1.8)}
      <circle cx="8" cy="8" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** The wall clock to the second, for a ledger that only exists while it is open. */
function useNowSecond(): number {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line lathe/no-unreasoned-state-sync -- interval that ticks the clock every second while the ledger is open
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/**
 * Holds the gateway's status stream open while the ledger shows in a visible window; the server
 * pushes each change through the server config, so the ledger moves with the gateway rather than
 * the provider health interval. A hidden window lets go: every push reaches every client, and
 * nobody is reading this one.
 */
function useLiveGateway(environmentId: EnvironmentId) {
  const visible = useSyncExternalStore(
    subscribeDocumentActivity,
    () => getDocumentActivity().visible,
  );
  useEnvironmentQuery(
    visible ? serverEnvironment.usageLimitSourceWatch({ environmentId, input: {} }) : null,
  );
}

/**
 * Whether the server is following the gateway's status stream. The dot is
 * lit while it is and flashes once with each update the stream brings, so a
 * quiet gateway and a dead connection never look the same.
 */
function LiveDot({ snapshot }: { readonly snapshot: UsageLimitSourceSnapshot }) {
  const following = snapshot.proxy?.following === true;
  const label = following
    ? "Live: following the gateway's status stream"
    : "Not live: waiting for the gateway's status stream";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="relative flex size-1.5 shrink-0" aria-label={label} tabIndex={0} />
        }
      >
        <span
          className={cn(
            "size-full rounded-full",
            following ? "bg-success" : "bg-muted-foreground/40",
          )}
        />
        {following ? (
          <span
            key={snapshot.checkedAt}
            aria-hidden
            className="absolute inset-0 rounded-full bg-success opacity-0 motion-safe:animate-status-ping-once"
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** A 3px bar with a hairline at the rotation threshold. */
function Meter({
  usedPercent,
  tone,
  threshold,
  className,
}: {
  readonly usedPercent: number;
  readonly tone: ProxyTone;
  readonly threshold: number;
  readonly className?: string;
}) {
  return (
    <span className={cn("relative block h-[3px] w-full rounded-full bg-muted", className)}>
      <span
        className={cn("absolute inset-y-0 left-0 rounded-full", TONE_FILL[tone])}
        style={{ width: `${Math.max(0, Math.min(100, usedPercent))}%` }}
      />
      <span
        aria-hidden
        className="absolute -inset-y-0.5 w-px bg-foreground/40"
        style={{ left: `${threshold}%` }}
      />
    </span>
  );
}

function windowsOf(account: ProxyAccountView | null) {
  const session = account?.windows.find((window) => window.key === "five_hour") ?? null;
  const weekly = account?.windows.find((window) => window.key === "seven_day") ?? null;
  return { session, weekly };
}

const GLYPHS: Record<ProxyWindowGlyph, typeof FeatherIcon> = { feather: FeatherIcon };

/** A window's label: its glyph with the full name on hover, or its short text. */
function WindowLabel({ window, className }: { window: ProxyWindowView; className?: string }) {
  if (!window.glyph) return <span className={cn("truncate", className)}>{window.label}</span>;
  const Glyph = GLYPHS[window.glyph];
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn("flex", className)} aria-label={window.title} tabIndex={0} />}
      >
        <Glyph className="size-2.5" aria-hidden />
      </TooltipTrigger>
      <TooltipPopup side="top">{window.title}</TooltipPopup>
    </Tooltip>
  );
}

/** The session, weekly, and first per-model window: what a row summarises. */
function summaryWindows(account: ProxyAccountView) {
  return [
    account.windows.find((window) => window.key === "five_hour") ?? null,
    account.windows.find((window) => window.key === "seven_day") ?? null,
    account.windows.find((window) => window.key.startsWith("seven_day_")) ?? null,
  ] as const;
}

/** Nested gauges: session outermost, then weekly, then the model window. */
function SummaryRings({ account }: { readonly account: ProxyAccountView }) {
  const radii = [6.6, 4.4, 2.2];
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90" aria-hidden>
      {summaryWindows(account).map((window, index) => (
        <g key={SUMMARY_KEYS[index]}>
          {ring(8, radii[index]!, window?.usedPercent ?? null, window?.tone ?? "muted", 1.4)}
        </g>
      ))}
    </svg>
  );
}

const SUMMARY_KEYS = ["session", "weekly", "model"] as const;

/** Three labelled meters side by side; a window the gateway lacks leaves its slot empty. */
function SummaryMeters({
  account,
  threshold,
}: {
  readonly account: ProxyAccountView;
  readonly threshold: number;
}) {
  return (
    <span className="flex items-end gap-1" aria-hidden>
      {summaryWindows(account).map((window, index) => (
        <span key={SUMMARY_KEYS[index]} className="flex w-6 flex-col items-center gap-0.5">
          {window ? (
            <>
              <WindowLabel
                window={window}
                className="h-2.5 items-center font-mono text-4xs leading-none text-muted-foreground"
              />
              <Meter usedPercent={window.usedPercent} tone={window.tone} threshold={threshold} />
            </>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/**
 * One account on one line: who, its state, a summary of its windows, and
 * the figure that decides its fate soonest. Clicking the row opens the
 * per-window breakdown under it.
 */
function LedgerRow({
  account,
  threshold,
  summaryStyle,
  expanded,
  onToggle,
  onLogin,
  redeem,
}: {
  readonly account: ProxyAccountView;
  readonly threshold: number;
  readonly summaryStyle: ProxyLedgerSummaryStyle;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** Present when the row offers a login: the account needs one or has one open. */
  readonly onLogin?: () => void;
  /** The card offers redemption; the hover peek cannot host its confirm dialog. */
  readonly redeem?: {
    readonly environmentId: EnvironmentId;
    readonly sourceId: string;
    readonly now: number;
    /** Redemptions by `resetRedeemKey`, kept by the ledger so a remounted row still shows them. */
    readonly states: ReadonlyMap<string, ResetCreditRedeemState>;
    readonly onState: (key: string, next: ResetCreditRedeemState) => void;
  };
}) {
  const slots = redeem ? resetCreditSlots(account, redeem.states) : [];
  const runway = onLogin ? (
    <Button
      size="micro"
      variant="ghost-destructive"
      className="justify-self-end"
      onClick={(event) => {
        event.stopPropagation();
        onLogin();
      }}
    >
      {account.runwayText || "login"}
    </Button>
  ) : (
    <div
      className={cn("text-right font-mono text-2xs tabular-nums", TONE_TEXT[account.runwayTone])}
    >
      {account.runwayText}
    </div>
  );
  return (
    <div className="py-1">
      <div
        className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto_2.25rem_4rem_1rem] items-center gap-x-2"
        onClick={onToggle}
      >
        <div className="min-w-0">
          <ProxyAccountIdentity id={account.id} driver={account.driver} />
          <div className={cn("truncate pl-5.5 text-2xs", TONE_TEXT[account.stateTone])}>
            {account.stateLabel}
            {account.resetCredits ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className={cn(
                        "ms-1.5 font-mono tabular-nums",
                        account.resetCredits.muted
                          ? "text-muted-foreground/60"
                          : "text-muted-foreground",
                      )}
                      tabIndex={0}
                    />
                  }
                >
                  {account.resetCredits.text}
                </TooltipTrigger>
                <TooltipPopup side="top" className="whitespace-pre-line">
                  {account.resetCredits.tooltip}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </div>
        {account.windows.length === 0 ? (
          <span className="text-3xs text-muted-foreground">no data</span>
        ) : summaryStyle === "meters" ? (
          <SummaryMeters account={account} threshold={threshold} />
        ) : (
          <SummaryRings account={account} />
        )}
        <div className="text-right font-mono text-2xs text-foreground tabular-nums">
          {account.headline}
        </div>
        {runway}
        <Button
          size="icon-tiny"
          variant="ghost-muted"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} ${account.id} windows`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          <ChevronRightIcon className={cn(expanded && "rotate-90")} />
        </Button>
      </div>
      {expanded && (account.windows.length > 0 || slots.length > 0) ? (
        <div className="flex flex-col gap-1 pt-1 pl-5.5">
          {account.windows.map((window) => (
            <div
              key={window.key}
              className="grid grid-cols-[1.25rem_1fr_3rem] items-center gap-1.5 font-mono text-3xs text-muted-foreground"
            >
              <WindowLabel window={window} />
              <Meter usedPercent={window.usedPercent} tone={window.tone} threshold={threshold} />
              {/* Every window counts down to its own reset; the runway column only shows the one that governs. */}
              <span className="text-right tabular-nums">{window.resetText}</span>
            </div>
          ))}
          {redeem && slots.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-border/60 pt-1.5">
              {slots.map((slot) => {
                const key = resetRedeemKey(account.id, slot.kind);
                const credits = (
                  <ResetCredits
                    environmentId={redeem.environmentId}
                    input={{
                      sourceId: UsageLimitSourceId.make(redeem.sourceId),
                      accountId: account.id,
                      creditId: slot.kind,
                    }}
                    credits={slot.credits}
                    now={redeem.now}
                    store={{
                      state: slot.redeem,
                      onChange: (next) => redeem.onState(key, next),
                    }}
                  />
                );
                return slot.kind === "fable" ? (
                  <div key={key} className="flex items-baseline gap-2">
                    <span className="text-3xs text-muted-foreground">Fable</span>
                    {credits}
                  </div>
                ) : (
                  <Fragment key={key}>{credits}</Fragment>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SignIn({
  environmentId,
  pill,
}: {
  readonly environmentId: EnvironmentId;
  readonly pill: ProxyPillView;
}) {
  const auth = useAtomCommand(serverEnvironment.usageLimitSourceAuth, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (action: "start" | "cancel" | "signOut") => {
    setBusy(true);
    setFailure(null);
    const result = await auth({
      environmentId,
      input: { sourceId: pill.sourceId as never, action },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      setFailure(
        "error" in result.cause && result.cause.error instanceof Error
          ? result.cause.error.message
          : "The gateway sign-in could not be started.",
      );
    }
  };
  if (pill.status === "pending" && pill.pending) {
    return (
      <div className="flex flex-col gap-2">
        <div className="text-muted-foreground">
          Open the sign-in page and confirm this device code. Then sign in with your password and
          your second factor: a passkey, or the code from your authenticator app. Any browser on any
          device will do.
        </div>
        <div className="flex items-center justify-between gap-3">
          <code className="rounded bg-muted px-2 py-1 font-mono text-sm tracking-widest text-foreground">
            {pill.pending.userCode}
          </code>
          <Button
            size="xs"
            variant="outline"
            render={<a href={pill.pending.verificationUrl} target="_blank" rel="noreferrer" />}
          >
            Open sign-in
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">
            This panel updates on its own once you finish.
          </span>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void run("cancel")}>
            Cancel
          </Button>
        </div>
        {failure ? <div className="text-error-foreground">{failure}</div> : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted-foreground">
        {pill.status === "signedOut"
          ? "Sign in as yourself to see which account the gateway is serving and how much headroom is left."
          : (pill.error ?? "The gateway could not be read.")}
      </div>
      <div className="flex items-center justify-end gap-2">
        {pill.status !== "signedOut" ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void run("signOut")}>
            Sign out
          </Button>
        ) : null}
        {pill.status === "signedOut" ? (
          <Button size="xs" disabled={busy} onClick={() => void run("start")}>
            Sign in
          </Button>
        ) : null}
      </div>
      {failure ? <div className="text-error-foreground">{failure}</div> : null}
    </div>
  );
}

export function Ledger({
  environmentId,
  snapshot,
  threshold,
  variant,
  onClose,
  loginFor,
  onLoginFor,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: UsageLimitSourceSnapshot;
  readonly threshold: number;
  /**
   * The card's narrow column rather than the hover peek. Only the card shows
   * login panels; the peek's login control opens the card on that account.
   */
  readonly variant: "peek" | "card";
  /** The account whose login panel is open, if any. */
  readonly loginFor: string | null;
  readonly onLoginFor: (account: string | null) => void;
  /** The card's close control. */
  readonly onClose?: () => void;
}) {
  // The peek and the card unmount when they close, so this second-by-second
  // clock and the re-derivation it drives only run while someone is looking.
  const now = useNowSecond();
  const pill = deriveProxyPill(snapshot, now, { seconds: true });
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const auth = useAtomCommand(serverEnvironment.usageLimitSourceAuth, { reportFailure: false });
  useLiveGateway(environmentId);
  const summaryStyle = useClientSettings((settings) => settings.proxyLedgerSummaryStyle);
  // Rows open independently and stay open while the ledger does.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // Redemptions live here, not in the row: a reset can move the account to
  // the other group and spend its last credit, which remounts the row.
  const [redeems, setRedeems] = useState<ReadonlyMap<string, ResetCreditRedeemState>>(
    () => new Map(),
  );
  const setRedeem = (key: string, next: ResetCreditRedeemState) =>
    setRedeems((previous) => new Map(previous).set(key, next));
  if (!pill) return null;
  const narrow = variant === "card";
  const row = (account: ProxyAccountView) => (
    <div key={account.id}>
      <LedgerRow
        account={account}
        threshold={threshold}
        summaryStyle={summaryStyle}
        expanded={expanded.has(account.id)}
        onToggle={() => toggle(account.id)}
        {...(account.needsLogin || account.login
          ? {
              onLogin: () => onLoginFor(narrow && loginFor === account.id ? null : account.id),
            }
          : {})}
        {...(narrow
          ? {
              redeem: {
                environmentId,
                sourceId: pill.sourceId,
                now,
                states: redeems,
                onState: setRedeem,
              },
            }
          : {})}
      />
      {narrow && loginFor === account.id ? (
        <div className="mb-1.5 rounded-md border border-border/60 bg-muted/40 p-2">
          <ProxyLoginPanel
            environmentId={environmentId}
            sourceId={pill.sourceId}
            account={account}
            onClose={() => onLoginFor(null)}
          />
        </div>
      ) : null}
    </div>
  );
  return (
    <div
      className={cn("flex flex-col gap-2 text-xs", narrow ? "p-3" : "p-(--floating-content-inset)")}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5">
          {pill.status === "live" ? <LiveDot snapshot={snapshot} /> : null}
          <span className="truncate font-medium text-muted-foreground">
            {pill.label} · {pill.accounts.length}{" "}
            {pill.accounts.length === 1 ? "account" : "accounts"}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-2xs whitespace-nowrap text-secondary-label">
            {pill.runwayText ? `${narrow ? "runway" : "fleet runway"} ${pill.runwayText}` : ""}
          </span>
          {onClose ? (
            <Button size="icon-micro" variant="ghost-muted" aria-label="Close" onClick={onClose}>
              <XIcon />
            </Button>
          ) : null}
        </span>
      </div>
      {pill.status === "live" ? (
        <>
          <div className="flex flex-col gap-1.5">
            {pill.groups.map((group) => (
              <div key={group.driver}>
                <div className="flex items-center gap-2 text-3xs tracking-wider text-muted-foreground uppercase after:h-px after:flex-1 after:bg-border/60">
                  {group.label}
                </div>
                {group.available.map(row)}
                {group.unavailable.length > 0 && group.available.length > 0 ? (
                  <div className="mt-0.5 border-t border-dashed border-border/60" />
                ) : null}
                {group.unavailable.map(row)}
              </div>
            ))}
          </div>
          {pill.fallbacks.length > 0 ? (
            <div className="border-t border-border/60 pt-1.5 font-mono text-2xs text-muted-foreground">
              {pill.fallbacks.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-1.5 font-mono text-2xs text-secondary-label">
            <span>{pill.footer}</span>
            {confirmSignOut ? (
              <span className="flex items-center gap-1">
                <Button size="micro" variant="ghost" onClick={() => setConfirmSignOut(false)}>
                  Keep
                </Button>
                <Button
                  size="micro"
                  variant="destructive-outline"
                  onClick={() => {
                    setConfirmSignOut(false);
                    void auth({
                      environmentId,
                      input: { sourceId: pill.sourceId as never, action: "signOut" },
                    });
                  }}
                >
                  Sign out
                </Button>
              </span>
            ) : (
              <Button size="micro" variant="ghost" onClick={() => setConfirmSignOut(true)}>
                Sign out
              </Button>
            )}
          </div>
        </>
      ) : (
        <SignIn environmentId={environmentId} pill={pill} />
      )}
    </div>
  );
}

function pillLabel(pill: ProxyPillView): string {
  switch (pill.status) {
    case "signedOut":
      return "Sign in";
    case "pending":
      return "Finish sign-in";
    case "offline":
      return "offline";
    default:
      return pill.fallbackText ?? pill.current?.headline ?? "pool";
  }
}

/**
 * The gateway's serving account and headroom, at the size of the other header controls: two bars
 * for its session and weekly windows against the rotation threshold, the session figure, then the
 * fleet runway after the rule. Hover peeks at every pooled account; click opens the card under
 * the thread details card, where logins happen.
 */
export function ProxyUsagePill({
  environmentId: threadEnvironmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const minute = useNowMinute();
  const selected = selectProxySource(configs, [threadEnvironmentId, primaryEnvironmentId]);
  const snapshot: UsageLimitSourceSnapshot | undefined = selected?.snapshot;
  const environmentId = (selected?.environmentId ?? threadEnvironmentId) as EnvironmentId;
  const threshold = snapshot?.proxy?.rotationThresholdPercent ?? 90;
  const pill = snapshot ? deriveProxyPill(snapshot, Date.parse(`${minute}:00Z`)) : null;
  // Hovering peeks at the ledger; clicking opens the card under the thread details card, which
  // stays until closed (a login sends the user to another window); the peek stands down meanwhile.
  // Without room for its column the card steps aside, remembering it was open, and a click opens
  // it over the chat until closed or room returns. A login in progress shows either way.
  const [hovered, setHovered] = useState(false);
  const loginFor = useAtomValue(proxyLoginPanelAtom);
  const setLoginFor = useAtomSet(proxyLoginPanelAtom);
  const cardRequested = useAtomValue(proxyStatusCardOpenAtom);
  const setCardRequested = useAtomSet(proxyStatusCardOpenAtom);
  const [popoverRequested, setPopoverRequested] = useState(false);
  const placement = useThreadSideCardPlacement(
    "iris",
    cardRequested || popoverRequested || loginFor !== null,
  );
  const mode = placement?.mode ?? null;
  const cardOpen =
    loginFor !== null || (mode === "inline" ? cardRequested : popoverRequested && mode !== null);
  // Room coming back ends the popover, as it does the details card's.
  if (mode === "inline" && popoverRequested) setPopoverRequested(false);
  const closeCard = () => {
    setLoginFor(null);
    if (mode === "popover") setPopoverRequested(false);
    else setCardRequested(false);
  };
  if (!pill) return null;
  const { session, weekly } = windowsOf(pill.current);
  const dim = pill.status !== "live";
  const tone = pill.tone;
  return (
    <>
      <Popover
        open={hovered && !cardOpen}
        onOpenChange={(next, details) => {
          // A press toggles the card instead; see the trigger's onClick.
          if (details.reason === "trigger-press") return;
          setHovered(next);
        }}
      >
        <PopoverTrigger
          openOnHover
          delay={150}
          closeDelay={150}
          render={
            <Button
              size="xs"
              variant="outline"
              data-toolbar-control=""
              aria-expanded={cardOpen}
              aria-label={`${pill.label}: ${pill.current ? `${pill.current.id} ${pill.current.headline}` : pillLabel(pill)}`}
              onClick={() => {
                setHovered(false);
                if (cardOpen) closeCard();
                else if (measureThreadSideCard("iris")?.mode === "popover")
                  setPopoverRequested(true);
                else setCardRequested(true);
              }}
            />
          }
        >
          <span className={cn("relative flex items-center gap-2", dim && "text-muted-foreground")}>
            {pill.needsLogin > 0 ? (
              <span
                aria-label={`${pill.needsLogin} ${pill.needsLogin === 1 ? "account needs" : "accounts need"} a login`}
                className="absolute -top-1 -left-1 size-1.5 rounded-full bg-error"
              />
            ) : null}
            <IrisGauge
              session={pill.status === "live" ? session : null}
              weekly={pill.status === "live" ? weekly : null}
              className={cn(
                pill.status === "pending" && "text-warning-foreground",
                tone === "crit" && !dim && "text-error-foreground",
                dim && "opacity-60",
              )}
            />
            {pill.status === "live" ? (
              <span className="flex w-8 flex-col gap-0.75" aria-hidden>
                <Meter
                  usedPercent={session?.usedPercent ?? (pill.fallbackText ? 100 : 0)}
                  tone={session?.tone ?? tone}
                  threshold={threshold}
                />
                <Meter
                  usedPercent={weekly?.usedPercent ?? (pill.fallbackText ? 100 : 0)}
                  tone={weekly?.tone ?? tone}
                  threshold={threshold}
                />
              </span>
            ) : null}
            <span
              className={cn(
                "font-mono text-xs tabular-nums",
                pill.status === "live" && pill.fallbackText && "text-error-foreground",
              )}
            >
              {pillLabel(pill)}
            </span>
            {pill.status === "live" && pill.runwayText ? (
              <>
                <span className="h-3.5 w-px bg-border" aria-hidden />
                <span
                  className={cn(
                    "hidden font-mono text-xs tabular-nums @3xl/header-actions:inline",
                    tone === "crit" ? "text-error-foreground" : "text-muted-foreground",
                  )}
                >
                  {pill.runwayText}
                </span>
              </>
            ) : null}
          </span>
        </PopoverTrigger>
        <PopoverPopup
          tooltipStyle
          side="bottom"
          align="end"
          padding="none"
          // Wide enough that each window's reset countdown leaves its meter the same length.
          className="w-[24.5rem] max-w-none text-left whitespace-normal"
        >
          {snapshot ? (
            <Ledger
              environmentId={environmentId}
              snapshot={snapshot}
              threshold={threshold}
              variant="peek"
              loginFor={loginFor}
              onLoginFor={(account) => {
                setHovered(false);
                setLoginFor(account);
              }}
            />
          ) : null}
        </PopoverPopup>
      </Popover>
      {cardOpen && placement && snapshot ? (
        <ProxyStatusCard placement={placement} onClose={closeCard}>
          <Ledger
            // Redeem status and open rows are kept per account name, which two
            // gateways can share; a new environment or source starts fresh.
            key={`${environmentId}:${snapshot.id}`}
            environmentId={environmentId}
            snapshot={snapshot}
            threshold={threshold}
            variant="card"
            loginFor={loginFor}
            onLoginFor={setLoginFor}
            onClose={closeCard}
          />
        </ProxyStatusCard>
      ) : null}
    </>
  );
}
