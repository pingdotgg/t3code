import {
  EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  collectProviderUsageLimits,
  displayLimitWindows,
  hubRoutes,
  instanceHubs,
  type LimitPoolWindow,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { limitsNotice } from "@t3tools/shared/usageLimitsCopy";

export type ThreadDetailsLimits =
  | { readonly kind: "instance"; readonly limits: ServerProviderUsageLimits }
  | { readonly kind: "pool"; readonly windows: readonly LimitPoolWindow[] };

// collectLimitAccounts keys its input by environment; the card reads one, so any id serves.
const CARD_ENVIRONMENT = EnvironmentId.make("thread-details");

export function resolveThreadDetailsLimits(
  providerInstanceId: ProviderInstanceId | null,
  model: string | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  if (!provider) return null;
  const report = collectProviderUsageLimits(provider.instanceId, providers, sources, now, model);
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const own =
    report?.accounts.find((entry) => entry.instanceId === provider.instanceId)?.limits ??
    provider.usageLimits;
  if (!own) return null;
  const hubs = instanceHubs(provider, sources);
  if (limitsNotice(own) === null || hubs.length === 0) return { kind: "instance", limits: own };
  // An instance sent to a hub reads no limits of its own; its hub pools the accounts it spends.
  return hubPool(provider.driver, model, providers, hubs, now) ?? { kind: "instance", limits: own };
}

export function resolveThreadHttpQuotas(
  providerInstanceId: ProviderInstanceId | null,
  sources: UsageLimitSourceSnapshots,
) {
  if (providerInstanceId === null) return [];
  return sources.flatMap((source) =>
    source.kind === "http"
      ? (source.quotaAccounts ?? []).flatMap((account) =>
          account.providerInstanceId === providerInstanceId
            ? account.windows.map((window) => ({
                key: JSON.stringify([source.id, account.id, window.id]),
                accountLabel: account.label,
                window,
              }))
            : [],
        )
      : [],
  );
}

export function nextPoolReset(window: LimitPoolWindow, now: number) {
  const pooled = window.members.length > 1;
  return (
    window.resets.find((reset) => reset.at > now && (!pooled || reset.restoresPercent > 0)) ?? null
  );
}

function hubPool(
  driver: ServerProvider["driver"],
  model: string | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  const routes = hubRoutes(sources, driver, model);
  const routed = sources.map((source) => ({
    ...source,
    accounts: source.accounts.filter(routes),
  }));
  const readable = routed
    .flatMap((source) => source.accounts)
    .filter((account) => limitsNotice(account.usageLimits) === null);
  if (readable.length === 0) return null;
  // A signed-in login joins the pool only as a fresher reading of an account the hub routes to.
  const signedIn = providers.filter((provider) =>
    readable.some(
      (account) =>
        account.driver === provider.driver &&
        account.workspaceId === provider.auth.workspaceId &&
        account.email !== undefined &&
        account.email.toLowerCase() === provider.auth.email?.toLowerCase(),
    ),
  );
  const presentations = new Map([
    [
      CARD_ENVIRONMENT,
      {
        entry: { target: { label: "" } },
        serverConfig: { providers: signedIn, usageLimitSources: routed },
      },
    ],
  ]);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  return pools.length > 0 ? { kind: "pool", windows: pools.flatMap(displayLimitWindows) } : null;
}

export function poolSources(window: LimitPoolWindow) {
  const hubs = window.members.flatMap(({ account }) =>
    account.environments.length === 0 && account.sourceLabel ? [account.sourceLabel] : [],
  );
  const signedIn = window.members.some(({ account }) => account.environments.length > 0);
  return { hubs: [...new Set(hubs)], signedIn };
}

export function limitTone(left: number, runsOutBeforeReset = false): "error" | "warning" | null {
  if (left <= 10) return "error";
  if (left <= 20 || runsOutBeforeReset) return "warning";
  return null;
}

/** Short window names pair up two across; shared or compound labels span the card width. */
export function isWideLimitLabel(label: string): boolean {
  return label.length > 9 || label.includes("\u00b7");
}

type FoldedWindow = Pick<ServerProviderUsageWindow, "id" | "kind" | "label" | "usedPercent">;

/** Whether a window meters the model, or null when its data cannot say. */
function windowMetersModel(
  driver: ServerProvider["driver"] | undefined,
  window: FoldedWindow,
  model: string | null,
): boolean | null {
  if (model === null) return null;
  if (driver === "claudeAgent" && window.id.startsWith("seven_day_")) {
    const scope = window.id.slice("seven_day_".length);
    return `_${model.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_`.includes(`_${scope}_`);
  }
  return true;
}

/**
 * The limit rows shown before "Show N more": those metering the thread's model when the windows
 * say, else the two nearest their limit, one per period. A row near its limit or running out
 * before it resets always shows.
 */
export function foldLimitRows<
  Row extends {
    readonly driver: ServerProvider["driver"] | undefined;
    readonly window: FoldedWindow;
    readonly runsOutBeforeReset?: boolean;
  },
>(rows: readonly Row[], model: string | null) {
  const meters = rows.map((row) => windowMetersModel(row.driver, row.window, model));
  const known = !meters.includes(null) && meters.includes(true);
  const nearest = rows.toSorted(
    (left, right) => remainingPercent(left.window) - remainingPercent(right.window),
  );
  const perPeriod = nearest.filter(
    (row, index) => nearest.findIndex((other) => other.window.kind === row.window.kind) === index,
  );
  const kept = new Set(
    known
      ? rows.filter((_, index) => meters[index])
      : [...perPeriod, ...nearest.filter((row) => !perPeriod.includes(row))].slice(0, 2),
  );
  for (const row of rows) {
    if (limitTone(remainingPercent(row.window), row.runsOutBeforeReset) !== null) kept.add(row);
  }
  return {
    shown: rows.filter((row) => kept.has(row)),
    hidden: rows.filter((row) => !kept.has(row)),
  };
}

function compareLimitTightness(
  left: { readonly window: FoldedWindow; readonly runsOutBeforeReset?: boolean },
  right: { readonly window: FoldedWindow; readonly runsOutBeforeReset?: boolean },
): number {
  return (
    remainingPercent(left.window) - remainingPercent(right.window) ||
    Number(Boolean(right.runsOutBeforeReset)) - Number(Boolean(left.runsOutBeforeReset))
  );
}

/** Group limit rows by provider driver, ordering both groups and windows tightest first. */
export function groupLimitRows<
  Row extends {
    readonly driver: ServerProvider["driver"] | undefined;
    readonly window: FoldedWindow;
    readonly runsOutBeforeReset?: boolean;
  },
>(
  rows: readonly Row[],
): ReadonlyArray<{
  readonly driver: ServerProvider["driver"] | undefined;
  readonly rows: readonly Row[];
}> {
  const byDriver = new Map<ServerProvider["driver"] | undefined, Row[]>();
  for (const row of rows) {
    const existing = byDriver.get(row.driver);
    if (existing) existing.push(row);
    else byDriver.set(row.driver, [row]);
  }
  return [...byDriver]
    .map(([driver, entries]) => ({
      driver,
      rows: entries.toSorted(compareLimitTightness),
    }))
    .toSorted((left, right) => {
      const a = left.rows[0];
      const b = right.rows[0];
      if (!a || !b) return 0;
      return compareLimitTightness(a, b);
    });
}
