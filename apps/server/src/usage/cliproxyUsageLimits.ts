/**
 * Maps a CLIProxyAPI hub's `quota-scheduler/status` response onto the usage
 * limit windows the Limits view renders, one account per pooled auth file.
 *
 * The hub already normalises each upstream: Claude accounts carry
 * `five_hour` / `seven_day` / `fable`, Codex accounts `five_hour` / `weekly`.
 * Every window is `{ used_percent, reset_at?, known, hard_limited }`.
 *
 * @module usage/cliproxyUsageLimits
 */
import {
  ProviderDriverKind,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { codexPlanLabel } from "../provider/Layers/CodexProvider.ts";
import { clampPercent, makeUsageLimits } from "../provider/providerUsageLimits.ts";

const QuotaWindow = Schema.Struct({
  used_percent: Schema.Number,
  reset_at: Schema.optional(Schema.String),
  known: Schema.optional(Schema.Boolean),
  hard_limited: Schema.optional(Schema.Boolean),
});

const QuotaAccount = Schema.Struct({
  provider: Schema.String,
  plan: Schema.optional(Schema.String),
  fetched_at: Schema.optional(Schema.String),
  five_hour: Schema.optional(QuotaWindow),
  seven_day: Schema.optional(QuotaWindow),
  weekly: Schema.optional(QuotaWindow),
  fable: Schema.optional(QuotaWindow),
});

export const CliproxyQuotaStatus = Schema.Struct({
  accounts: Schema.Record(Schema.String, QuotaAccount),
});
export type CliproxyQuotaStatus = typeof CliproxyQuotaStatus.Type;
export const decodeCliproxyQuotaStatus = Schema.decodeUnknownEffect(CliproxyQuotaStatus);

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

/** Window ids match what the provider drivers emit, so rows read the same across sources. */
const WINDOWS: ReadonlyArray<{
  readonly key: keyof Omit<typeof QuotaAccount.Type, "provider" | "plan" | "fetched_at">;
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly windowDurationMins: number;
}> = [
  {
    key: "five_hour",
    id: "five_hour",
    kind: "session",
    label: "Session",
    windowDurationMins: SESSION_MINS,
  },
  {
    key: "seven_day",
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: WEEK_MINS,
  },
  {
    key: "weekly",
    id: "secondary",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: WEEK_MINS,
  },
  {
    key: "fable",
    id: "seven_day_fable",
    kind: "weekly",
    label: "Weekly · Fable",
    windowDurationMins: WEEK_MINS,
  },
];

const DRIVER_BY_HUB_PROVIDER: Readonly<Record<string, ProviderDriverKind>> = {
  claude: ProviderDriverKind.make("claudeAgent"),
  codex: ProviderDriverKind.make("codex"),
};

function isoFromHub(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

/** `claude-julius@ping.gg.json` → `julius@ping.gg`; `codex-<hash>-x@y-pro.json` → `x@y`. */
export function accountEmailFromAuthFile(fileName: string): string | undefined {
  const stem = fileName.replace(/\.json$/i, "");
  // Strip the provider prefix (and Codex's hash) rather than splitting on
  // `-`, so a hyphenated local part such as `first-last@` survives.
  return stem.match(/^(?:claude-|codex-[a-z0-9]+-)?([^\s/]+@[^\s/]+?)(?:-[a-z0-9]+)?$/i)?.[1];
}

/**
 * The hub only reports a plan slug for Codex. Claude accounts carry no tier
 * in the scheduler status, so the row says what it is: a Claude subscription.
 */
function planLabel(account: typeof QuotaAccount.Type): string | undefined {
  if (account.provider === "codex") return codexPlanLabel(account.plan);
  if (account.provider === "claude") return "Claude Subscription";
  return undefined;
}

export function cliproxyAccountToUsageLimits(
  account: typeof QuotaAccount.Type,
  checkedAt: string,
): ServerProviderUsageLimits {
  const windows: ServerProviderUsageWindow[] = [];
  for (const spec of WINDOWS) {
    const window = account[spec.key];
    if (!window || window.known === false) continue;
    const resetsAt = isoFromHub(window.reset_at);
    windows.push({
      // Codex names its five-hour window by position, so a hub row and a
      // native row for the same account pool together.
      id: spec.key === "five_hour" && account.provider === "codex" ? "primary" : spec.id,
      kind: spec.kind,
      label: spec.label,
      windowDurationMins: spec.windowDurationMins,
      // The hub flags a window it has seen a 429 on; the percent may lag.
      usedPercent: window.hard_limited ? 100 : clampPercent(window.used_percent),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return makeUsageLimits({ checkedAt: isoFromHub(account.fetched_at) ?? checkedAt, windows });
}

export function cliproxyStatusToAccounts(
  status: CliproxyQuotaStatus,
  checkedAt: string,
): ReadonlyArray<UsageLimitSourceAccount> {
  const accounts: UsageLimitSourceAccount[] = [];
  for (const [fileName, account] of Object.entries(status.accounts)) {
    const driver = DRIVER_BY_HUB_PROVIDER[account.provider];
    if (!driver) continue;
    const email = accountEmailFromAuthFile(fileName);
    const plan = planLabel(account);
    accounts.push({
      id: fileName,
      driver,
      ...(email ? { email } : {}),
      ...(plan ? { plan } : {}),
      usageLimits: cliproxyAccountToUsageLimits(account, checkedAt),
    });
  }
  return accounts.toSorted(
    (left, right) => left.driver.localeCompare(right.driver) || left.id.localeCompare(right.id),
  );
}
