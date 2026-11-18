/**
 * What the header pill and its ledger show for a `modelproxy` usage-limit source, pure over the
 * published snapshot so the rules (which account, which colour, which figure decides soonest) are
 * testable without React. The runway rule mirrors modelproxy's mini window: a spent shared
 * window's reset governs, else the fleet forecast, else the horizon.
 */
import type {
  ServerProviderResetCredits,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
  UsageLimitSourceAccountLogin,
  UsageLimitSourceSnapshot,
} from "@lathe/contracts";
import { formatDuration } from "@lathe/shared/usageLimits";

import type { ResetCreditRedeemState } from "../usage/UsageLimits";

export type ProxyTone = "ok" | "warn" | "crit" | "muted";
export type ProxyWindowGlyph = "feather";

/** Model families whose weekly window is drawn as a glyph rather than cut-off text. */
const MODEL_GLYPHS: Record<string, ProxyWindowGlyph> = { fable: "feather" };

export interface ProxyWindowView {
  readonly key: string;
  /** Short text label: `5h`, `7d`, or a model family the ledger has no glyph for. */
  readonly label: string;
  /** The window's full name, for a tooltip: `Weekly · Fable`. */
  readonly title: string;
  /** Drawn instead of the label for a model family that has one. */
  readonly glyph: ProxyWindowGlyph | null;
  readonly usedPercent: number;
  readonly tone: ProxyTone;
  /** Countdown to this window's own reset; empty when the source never observed one. */
  readonly resetText: string;
}

export interface ProxyAccountView {
  readonly id: string;
  readonly driver: string;
  readonly stateLabel: string;
  readonly stateTone: ProxyTone | "live";
  readonly windows: readonly ProxyWindowView[];
  /** The session window's percent, or the first window's when there is none. */
  readonly headline: string;
  /** The countdown or verdict that decides this account's fate soonest. */
  readonly runwayText: string;
  readonly runwayTone: ProxyTone;
  /** The gateway would route to this account now: live, ready, or on credits. */
  readonly available: boolean;
  /** When an unavailable account comes back, if the gateway knows. */
  readonly resumesAtMs: number | null;
  /** The gateway flagged the account's credential dead; a login fixes it. */
  readonly needsLogin: boolean;
  /** The account's open login on the gateway, if any. */
  readonly login: ProxyLoginView | null;
  /** Banked limit resets, or null when none are known or banked. */
  readonly resetCredits: ProxyResetCreditsView | null;
}

/**
 * One account's login as its panel shows it. `step` is what the panel asks
 * of the user now: paste the consent page's code, approve the device code
 * elsewhere, wait, or read the outcome.
 */
export interface ProxyLoginView {
  readonly sessionId: string;
  readonly mode: "paste" | "device";
  readonly step: "paste" | "approve" | "working" | "done" | "failed";
  readonly authorizeUrl: string | null;
  readonly userCode: string | null;
  readonly verificationUrl: string | null;
  /** What to tell the user beside the step; null when the step says it all. */
  readonly message: string | null;
}

/** One row's reset chip and what the card may redeem. */
export interface ProxyResetCreditsView {
  /** `↻1`, or `↻1 · F3` when Fable resets are banked too. */
  readonly text: string;
  /** None of the weekly resets would act now (Codex before a limit is hit). */
  readonly muted: boolean;
  readonly tooltip: string;
  /** Weekly resets to redeem, credit id "weekly"; null when none. */
  readonly weekly: ServerProviderResetCredits | null;
  /** Fable resets to redeem, credit id "fable"; null when none. */
  readonly fable: ServerProviderResetCredits | null;
}

/** The bucket a gateway credit id names; the gateway resolves the real grant. */
export type ProxyResetCreditKind = "weekly" | "fable";

/** One bucket a card row offers to redeem, with the redemption it holds, if any. */
export interface ProxyResetCreditSlot {
  readonly kind: ProxyResetCreditKind;
  /** The bucket, or an empty one once the last credit is spent. */
  readonly credits: ServerProviderResetCredits;
  readonly redeem: ResetCreditRedeemState | null;
}

export interface ProxyAccountGroup {
  readonly driver: string;
  readonly label: string;
  /** Serving account first, then the rest by name. */
  readonly available: readonly ProxyAccountView[];
  /** Soonest back first; accounts with no known return last. */
  readonly unavailable: readonly ProxyAccountView[];
}

export interface ProxyPillView {
  readonly sourceId: string;
  readonly label: string;
  readonly status: "signedOut" | "pending" | "offline" | "live";
  /** The account the gateway is serving, when it is signed in and serving one. */
  readonly current: ProxyAccountView | null;
  readonly tone: ProxyTone;
  readonly runwayText: string;
  readonly fallbackText: string | null;
  readonly accounts: readonly ProxyAccountView[];
  /** The accounts by provider, each split into those serving now and those waiting. */
  readonly groups: readonly ProxyAccountGroup[];
  readonly fallbacks: readonly string[];
  readonly footer: string;
  readonly pending: { userCode: string; verificationUrl: string; expiresAt: string } | null;
  readonly error: string | null;
  /** How many accounts need a login, for the trigger's dot. */
  readonly needsLogin: number;
}

/** The gateway's stable failure codes, as the next thing to do. */
/** Claude's emailed sign-in code belongs on Claude's page; the panel says so. */
export const EMAIL_CODE_ADVICE =
  "That is Claude's email sign-in code: enter it on Claude's sign-in page. After you approve, Claude shows a long code with a # in it; paste that here.";

const LOGIN_ADVICE: Record<string, string> = {
  bad_code: "That code didn't work. Copy it again from the consent page and paste it here.",
  email_code: EMAIL_CODE_ADVICE,
  provider_unavailable: "Couldn't reach the provider just now. Try again.",
  save_failed: "Logged in, but the gateway could not save it: it will not survive a restart.",
};

/**
 * Whether a pasted value is a short numeric code, the shape of Claude's
 * emailed sign-in code. The login code is a long opaque token with a `#`.
 */
export function looksLikeEmailCode(value: string): boolean {
  const trimmed = value.trim();
  if (!/^[\d -]+$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, "").length;
  return digits >= 4 && digits <= 10;
}

function loginView(login: UsageLimitSourceAccountLogin): ProxyLoginView {
  const step: ProxyLoginView["step"] =
    login.state === "awaiting_code"
      ? "paste"
      : login.state === "awaiting_approval"
        ? "approve"
        : login.state === "exchanging"
          ? "working"
          : login.state === "completed"
            ? "done"
            : "failed";
  const advice = login.errorCode ? LOGIN_ADVICE[login.errorCode] : undefined;
  // A code this build has no advice for still says something: the gateway's
  // own message for it.
  const message =
    advice ??
    (login.state === "expired" ? "The login timed out." : null) ??
    (step === "failed" ? (login.error ?? "The login failed.") : null) ??
    (login.errorCode ? (login.error ?? null) : null);
  return {
    sessionId: login.sessionId,
    mode: login.mode,
    step,
    authorizeUrl: login.authorizeUrl ?? null,
    userCode: login.userCode ?? null,
    verificationUrl: login.verificationUrl ?? null,
    message,
  };
}

const DEFAULT_THRESHOLD = 90;
const WARN_AT = 60;

function windowTone(usedPercent: number, threshold: number): ProxyTone {
  if (usedPercent >= threshold) return "crit";
  if (usedPercent >= WARN_AT) return "warn";
  return "ok";
}

function shortLabel(window: ServerProviderUsageWindow): string {
  if (window.id === "five_hour") return "5h";
  if (window.id === "seven_day") return "7d";
  if (window.id.startsWith("seven_day_")) return window.id.slice("seven_day_".length);
  return window.label;
}

/** `1:42:10` inside a day and `3d 04h` beyond it, so a watcher can see the clock move. */
export function formatCountdownSeconds(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hours)}h`;
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

function countdown(at: string | undefined, now: number, seconds = false): string {
  if (!at) return "";
  const ms = Date.parse(at) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  return seconds ? formatCountdownSeconds(ms) : formatDuration(ms);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `, next expires in 2h 0m`, `, next expires now` once passed, or nothing when unreadable. */
function expiry(at: string | undefined, now: number): string {
  const left = countdown(at, now, false);
  if (left === "") return "";
  return left === "now" ? ", next expires now" : `, next expires in ${left}`;
}

export function resetCreditsView(
  credits: ServerProviderResetCredits | undefined,
  now: number,
): ProxyResetCreditsView | null {
  if (!credits) return null;
  const { fable: _fable, ...weeklyBucket } = credits;
  const weekly = credits.availableCount;
  const fable = credits.fable?.availableCount ?? 0;
  if (weekly === 0 && fable === 0) return null;
  const muted = weekly > 0 && credits.usableNowCount === 0;
  const lines: string[] = [];
  if (weekly > 0)
    lines.push(`${plural(weekly, "weekly reset")}${expiry(credits.nextExpiresAt, now)}`);
  if (fable > 0) {
    lines.push(`${plural(fable, "Fable reset")}${expiry(credits.fable?.nextExpiresAt, now)}`);
  }
  if (muted) lines.push("None usable until a limit is reached");
  return {
    text: `↻${weekly}${fable > 0 ? ` · F${fable}` : ""}`,
    muted,
    tooltip: lines.join("\n"),
    weekly: weekly > 0 ? weeklyBucket : null,
    fable: credits.fable && fable > 0 ? { ...credits.fable } : null,
  };
}

/** Where the card keeps one account's redemption of one kind. */
export const resetRedeemKey = (accountId: string, kind: ProxyResetCreditKind) =>
  `${accountId}:${kind}`;

/**
 * The buckets a card row shows: each one with resets banked, and each one
 * whose redemption is in flight or answered. A reset can spend the last
 * credit and move the account to another group in one update, so the answer
 * outlives both the count and the row it was started from.
 */
export function resetCreditSlots(
  account: Pick<ProxyAccountView, "id" | "resetCredits">,
  redeems: ReadonlyMap<string, ResetCreditRedeemState>,
): ProxyResetCreditSlot[] {
  return (["weekly", "fable"] as const).flatMap((kind) => {
    const bucket = account.resetCredits?.[kind] ?? null;
    const held = redeems.get(resetRedeemKey(account.id, kind)) ?? null;
    const redeem = held && (held.busy || held.status !== null) ? held : null;
    if (bucket === null && redeem === null) return [];
    return [{ kind, credits: bucket ?? { availableCount: 0 }, redeem }];
  });
}

function spent(window: ServerProviderUsageWindow, threshold: number, now: number): boolean {
  if (window.usedPercent < threshold) return false;
  return !window.resetsAt || Date.parse(window.resetsAt) > now;
}

function accountView(
  account: UsageLimitSourceAccount,
  input: {
    threshold: number;
    modelThreshold: number;
    now: number;
    seconds: boolean;
    login: UsageLimitSourceAccountLogin | undefined;
  },
): ProxyAccountView {
  const windows = account.usageLimits.windows.map((window): ProxyWindowView => {
    const threshold =
      window.id === "five_hour" || window.id === "seven_day"
        ? input.threshold
        : input.modelThreshold;
    const label = shortLabel(window);
    return {
      key: window.id,
      label,
      title: window.label,
      glyph: window.id.startsWith("seven_day_") ? (MODEL_GLYPHS[label] ?? null) : null,
      usedPercent: window.usedPercent,
      tone: windowTone(window.usedPercent, threshold),
      resetText: countdown(window.resetsAt, input.now, input.seconds),
    };
  });
  const session = account.usageLimits.windows.find((window) => window.id === "five_hour");
  const first = account.usageLimits.windows[0];
  const headline = session ?? first;

  const proxy = account.proxy;
  let stateLabel = "ready";
  let stateTone: ProxyAccountView["stateTone"] = "muted";
  let runwayText = "";
  let runwayTone: ProxyTone = "muted";
  let resumesAt: string | undefined;
  switch (proxy?.state) {
    case "live":
      stateLabel = proxy.inflight > 0 ? `live now · ${proxy.inflight} in flight` : "live now";
      stateTone = "live";
      break;
    case "cooling":
      stateLabel = proxy.coolingUntil
        ? `cooling · back in ${countdown(proxy.coolingUntil, input.now, input.seconds)}`
        : "circuit open";
      stateTone = "crit";
      runwayText = proxy.coolingUntil
        ? countdown(proxy.coolingUntil, input.now, input.seconds)
        : "circuit";
      runwayTone = "crit";
      resumesAt = proxy.coolingUntil;
      break;
    case "paused":
      stateLabel = "paused by operator";
      runwayText = "off";
      break;
    case "reauthentication":
      stateLabel = "login required";
      stateTone = "crit";
      runwayText = "login";
      runwayTone = "crit";
      break;
    case "suspended":
      stateLabel = "subscription suspended";
      stateTone = "crit";
      runwayText = "off";
      runwayTone = "crit";
      break;
    default:
      break;
  }
  if (runwayText === "") {
    // The shared windows take the account out of selection; a per-model
    // bucket only blocks that model, so it warns rather than governs.
    const shared = account.usageLimits.windows.filter(
      (window) => window.id === "five_hour" || window.id === "seven_day",
    );
    const spentShared = shared
      .filter((window) => spent(window, input.threshold, input.now))
      .toSorted(
        (left, right) => Date.parse(left.resetsAt ?? "") - Date.parse(right.resetsAt ?? ""),
      );
    const governing = spentShared[0];
    if (governing) {
      if (proxy?.credits) {
        stateLabel = "on credits";
        stateTone = "warn";
        runwayText = "credits";
        runwayTone = "warn";
      } else {
        stateLabel = `${shortLabel(governing)} spent`;
        stateTone = "crit";
        runwayText = governing.resetsAt
          ? countdown(governing.resetsAt, input.now, input.seconds)
          : "spent";
        runwayTone = "crit";
        resumesAt = governing.resetsAt;
      }
    } else {
      const soonest = [...account.usageLimits.windows]
        .filter((window) => window.resetsAt)
        .toSorted((left, right) => Date.parse(left.resetsAt!) - Date.parse(right.resetsAt!))[0];
      runwayText = soonest ? countdown(soonest.resetsAt, input.now, input.seconds) : "";
      runwayTone = "muted";
    }
  }

  return {
    id: account.id,
    driver: String(account.driver),
    stateLabel,
    stateTone,
    windows,
    headline: headline ? `${Math.round(headline.usedPercent)}%` : "no data",
    runwayText,
    runwayTone,
    available: stateTone !== "crit" && runwayText !== "off",
    resumesAtMs: resumesAt && Number.isFinite(Date.parse(resumesAt)) ? Date.parse(resumesAt) : null,
    needsLogin: proxy?.state === "reauthentication",
    login: input.login ? loginView(input.login) : null,
    resetCredits: resetCreditsView(account.usageLimits.resetCredits, input.now),
  };
}

const DRIVER_LABELS: Record<string, string> = { claudeAgent: "Anthropic", codex: "OpenAI" };
const DRIVER_ORDER = Object.keys(DRIVER_LABELS);

function driverRank(driver: string): number {
  const index = DRIVER_ORDER.indexOf(driver);
  return index === -1 ? DRIVER_ORDER.length : index;
}

function groupAccounts(accounts: readonly ProxyAccountView[]): ProxyAccountGroup[] {
  const drivers = [...new Set(accounts.map((account) => account.driver))].toSorted(
    (left, right) => driverRank(left) - driverRank(right),
  );
  return drivers.map((driver) => {
    const members = accounts.filter((account) => account.driver === driver);
    return {
      driver,
      label: DRIVER_LABELS[driver] ?? driver,
      available: members
        .filter((account) => account.available)
        .toSorted(
          (left, right) =>
            Number(right.stateTone === "live") - Number(left.stateTone === "live") ||
            left.id.localeCompare(right.id),
        ),
      unavailable: members
        .filter((account) => !account.available)
        .toSorted(
          (left, right) =>
            (left.resumesAtMs ?? Infinity) - (right.resumesAtMs ?? Infinity) ||
            left.id.localeCompare(right.id),
        ),
    };
  });
}

function fleetRunway(snapshot: UsageLimitSourceSnapshot, now: number, seconds: boolean): string {
  const runway = snapshot.proxy?.runway;
  if (!runway) return "";
  switch (runway.kind) {
    case "at":
      return countdown(runway.at, now, seconds) || "now";
    case "resetsFirst":
      return runway.at ? `resets ${countdown(runway.at, now, seconds)}` : "resets first";
    case "idle":
      return "idle";
    case "beyondHorizon":
      return ">7d";
    default:
      return "";
  }
}

function fallbackText(snapshot: UsageLimitSourceSnapshot): string | null {
  const fallbacks = snapshot.proxy?.fallback ?? [];
  const spend = fallbacks.reduce((total, fallback) => total + fallback.spendUsd, 0);
  if (fallbacks.length === 0) return null;
  const window = fallbacks[0]?.window;
  return `$${spend.toFixed(2)}${window === "day" ? " today" : window === "month" ? " this month" : ""}`;
}

/**
 * The gateway source the pill shows, with its owning environment. A gateway is the user's, not a
 * thread's: it is configured once, on whichever environment settings had selected, and every
 * thread should see it. The thread's environment wins, then the primary, then any other in catalog
 * order.
 */
export function selectProxySource<
  Config extends { usageLimitSources?: readonly UsageLimitSourceSnapshot[] | undefined },
>(
  configs: ReadonlyMap<string, Config>,
  preferred: ReadonlyArray<string | null>,
): { environmentId: string; snapshot: UsageLimitSourceSnapshot } | null {
  const order = [...preferred.filter((id): id is string => id !== null), ...configs.keys()];
  const seen = new Set<string>();
  for (const environmentId of order) {
    if (seen.has(environmentId)) continue;
    seen.add(environmentId);
    const snapshot = configs
      .get(environmentId)
      ?.usageLimitSources?.find((source) => source.kind === "modelproxy");
    if (snapshot) return { environmentId, snapshot };
  }
  return null;
}

/**
 * `null` for a source the pill does not represent. `seconds` renders every
 * countdown to the second, for a view that ticks while it is open.
 */
export function deriveProxyPill(
  snapshot: UsageLimitSourceSnapshot,
  now: number,
  options: { readonly seconds?: boolean } = {},
): ProxyPillView | null {
  if (snapshot.kind !== "modelproxy") return null;
  const seconds = options.seconds === true;
  const proxy = snapshot.proxy;
  const auth = proxy?.auth ?? { state: "signedOut" as const };
  const threshold = proxy?.rotationThresholdPercent ?? DEFAULT_THRESHOLD;
  const modelThreshold = proxy?.modelThresholdPercent ?? threshold;
  const logins = proxy?.accountLogins ?? [];
  const accounts = snapshot.accounts.map((account) =>
    accountView(account, {
      threshold,
      modelThreshold,
      now,
      seconds,
      login: logins.find((login) => login.account === account.id),
    }),
  );
  const current = accounts.find((account) => account.id === proxy?.current) ?? null;
  const fallbacks = (proxy?.fallback ?? []).map(
    (fallback) =>
      `${fallback.name} · $${fallback.spendUsd.toFixed(2)}${fallback.capUsd ? ` of $${fallback.capUsd.toFixed(0)}` : ""}${fallback.window ? ` per ${fallback.window}` : ""}`,
  );
  const footer = [
    `threshold ${threshold}%`,
    ...(proxy?.modelThresholdPercent !== undefined
      ? [`model ${proxy.modelThresholdPercent}%`]
      : []),
    ...(proxy?.queueDepth ? [`queue ${proxy.queueDepth}`] : []),
    ...(proxy?.inflightTotal ? [`${proxy.inflightTotal} in flight`] : []),
  ].join(" · ");

  const base = {
    sourceId: snapshot.id,
    label: snapshot.label,
    accounts,
    groups: groupAccounts(accounts),
    fallbacks,
    footer,
    pending:
      auth.state === "pending"
        ? {
            userCode: auth.userCode,
            verificationUrl: auth.verificationUrlComplete ?? auth.verificationUrl,
            expiresAt: auth.expiresAt,
          }
        : null,
    error: snapshot.error ?? null,
    needsLogin: accounts.filter((account) => account.needsLogin).length,
  };
  if (auth.state !== "signedIn") {
    return {
      ...base,
      status: auth.state,
      current: null,
      tone: "muted",
      runwayText: "",
      fallbackText: null,
    };
  }
  if (snapshot.error) {
    return {
      ...base,
      status: "offline",
      current: null,
      tone: "muted",
      runwayText: "",
      fallbackText: null,
    };
  }
  const poolSpent =
    current === null &&
    accounts.length > 0 &&
    accounts.every((account) => account.stateTone === "crit" || account.runwayText === "off");
  const tone: ProxyTone = poolSpent
    ? "crit"
    : current
      ? (current.windows.find((window) => window.key === "five_hour")?.tone ?? "ok")
      : "muted";
  return {
    ...base,
    status: "live",
    current,
    tone,
    runwayText: fleetRunway(snapshot, now, seconds),
    fallbackText: poolSpent ? fallbackText(snapshot) : null,
  };
}
