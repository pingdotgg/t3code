import type { UsageLimitSourceCredits } from "@t3tools/contracts";
import type { CreditBalance } from "@t3tools/shared/usageLimits";
import { formatUsd } from "@t3tools/shared/usageFormat";

import { type Icon, OpenRouterIcon } from "../Icons";

/**
 * Heading for each kind of credit source, mirroring how a pool section is
 * headed by its driver's mark and name. `cliproxy` is absent because a hub
 * reports pooled accounts, never a balance.
 */
const CREDIT_SOURCE_PRESENTATION: Partial<
  Record<CreditBalance["kind"], { readonly label: string; readonly mark: Icon }>
> = {
  openrouter: { label: "OpenRouter", mark: OpenRouterIcon },
};

/**
 * What `barColor` in ./UsageLimits falls back to for a driver with no brand
 * colour. OpenRouter is a source rather than a driver, so it takes that same
 * neutral and the card reads as one system with the pooled bars beside it.
 */
const BAR_COLOR = "var(--foreground)";

/**
 * The denominator a balance can be drawn against: what was bought for an
 * account, the cap for a single key. Without one there is a number but no bar,
 * because an uncapped key has no full to be a share of.
 */
function totalUsd(credits: UsageLimitSourceCredits): number | null {
  const total = credits.scope === "account" ? credits.purchasedUsd : credits.limitUsd;
  return total !== undefined && total > 0 ? total : null;
}

/**
 * What the big number counts. Money, not a share: the percentage belongs on
 * the bar, as it does on a pooled segment. An uncapped key knows only what it
 * has spent.
 */
function headline(credits: UsageLimitSourceCredits): { value: number; caption: string } {
  return credits.remainingUsd === undefined
    ? { value: credits.usedUsd, caption: "spent" }
    : { value: credits.remainingUsd, caption: "left" };
}

function detail(credits: UsageLimitSourceCredits): string {
  const spent = `${formatUsd(credits.usedUsd)} spent`;
  if (credits.scope === "account") {
    return credits.purchasedUsd === undefined
      ? spent
      : `${spent} of ${formatUsd(credits.purchasedUsd)} purchased`;
  }
  return credits.limitUsd === undefined
    ? `${spent} · no key limit`
    : `${spent} · key limit ${formatUsd(credits.limitUsd)}`;
}

/**
 * What the card adds over its section heading: a renamed source, the
 * environment when several report a balance, or nothing at all. A card headed
 * "OpenRouter" under a heading that already says so is noise.
 */
function cardSubtitle(balance: CreditBalance, providerLabel: string): string | null {
  const parts = [
    balance.label === providerLabel ? null : balance.label,
    balance.environmentLabel,
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * One prepaid balance. Shares `PoolWindowCard`'s frame so credits and quota
 * read as one view, but carries no countdown: credits do not reset, they run
 * out. The bar is a static fill for the same reason.
 */
function CreditCard({
  balance,
  providerLabel,
}: {
  readonly balance: CreditBalance;
  readonly providerLabel: string;
}) {
  const { credits } = balance;
  const subtitle = cardSubtitle(balance, providerLabel);
  const total = totalUsd(credits);
  const remaining = credits.remainingUsd;
  // Both the bar and the percentage need a denominator. An uncapped key has
  // none, so it shows money only rather than a share invented from nothing.
  const share =
    total === null || remaining === undefined
      ? null
      : Math.max(0, Math.min(100, (remaining / total) * 100));
  const percentLeft = share === null ? null : Math.round(share);
  const { value, caption } = headline(credits);
  const bar =
    share === null || remaining === undefined || total === null
      ? null
      : {
          share,
          label: `${percentLeft}% left · ${formatUsd(remaining)} of ${formatUsd(total)}`,
        };

  return (
    <div className="grid items-center gap-x-6 gap-y-3 rounded-lg border border-border/60 p-4 md:grid-cols-[11rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-1">
        {subtitle ? <span className="text-sm text-muted-foreground">{subtitle}</span> : null}
        <span className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {formatUsd(value)}
          </span>
          <span className="text-sm text-muted-foreground">{caption}</span>
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{detail(credits)}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {bar === null ? null : (
          <div
            role="img"
            aria-label={bar.label}
            className="relative h-8 min-w-0 overflow-hidden rounded-md bg-muted"
          >
            {/* Translucent, as the pooled segments are, so the fill reads in either theme. */}
            <div
              aria-hidden
              className="absolute inset-y-0 left-0 rounded-md opacity-35"
              style={{ width: `${bar.share}%`, backgroundColor: BAR_COLOR }}
            />
            {/* Hatched rather than blank, matching a pooled segment's spent share. Here it
                marks credits already burned: nothing resets them, only buying more. */}
            {bar.share < 100 ? (
              <div
                aria-hidden
                className="absolute inset-y-0 right-0 opacity-20"
                style={{
                  width: `${100 - bar.share}%`,
                  backgroundImage: `repeating-linear-gradient(135deg, ${BAR_COLOR} 0 1px, transparent 1px 5px)`,
                }}
              />
            ) : null}
            {/* Relative so it sits above the fill and hatching, as a pooled
                segment's own label does. The bar's aria-label already says it. */}
            <div className="relative flex h-full min-w-0 items-center px-2 text-xs">
              <span aria-hidden className="shrink-0 font-semibold text-foreground tabular-nums">
                {percentLeft}%
              </span>
            </div>
          </div>
        )}
        <span className="text-xs text-muted-foreground">
          {credits.scope === "account"
            ? "Account balance"
            : "This key's allowance · add a provisioning key to read the account balance"}
        </span>
      </div>
    </div>
  );
}

/**
 * Prepaid balances above the pooled quota, one section per provider so a
 * credit source is headed by its own mark and name exactly as a driver's pool
 * is. Sections follow first appearance, as the pools do.
 */
export function UsageCreditBalances({ balances }: { readonly balances: readonly CreditBalance[] }) {
  const groups = new Map<CreditBalance["kind"], CreditBalance[]>();
  for (const balance of balances) {
    const group = groups.get(balance.kind);
    if (group) group.push(balance);
    else groups.set(balance.kind, [balance]);
  }
  if (groups.size === 0) return null;

  return (
    <>
      {[...groups].map(([kind, group]) => {
        const presentation = CREDIT_SOURCE_PRESENTATION[kind];
        // An unknown credit source still shows its balance, named by the
        // source itself rather than vanishing behind a missing mark.
        const label = presentation?.label ?? group[0]!.label;
        const Mark = presentation?.mark;
        return (
          <section key={kind} className="flex flex-col gap-3">
            <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
              {/* Height-matched to the pooled sections' size-4 glyphs; the width
                  follows the mark's own ratio rather than being squared off. */}
              {Mark ? (
                <Mark className="h-4 w-auto shrink-0 text-foreground/80" aria-hidden />
              ) : null}
              {label}
            </h2>
            {group.map((balance) => (
              <CreditCard key={balance.key} balance={balance} providerLabel={label} />
            ))}
          </section>
        );
      })}
    </>
  );
}
