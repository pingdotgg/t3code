import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { clampPercent, makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// `exhaustedUsageWindow` in @t3tools/shared/usageLimits matches the overage id.
const KIRO_CREDITS_WINDOW_ID = "credits";
const KIRO_OVERAGE_WINDOW_ID = "overage";

const KiroUsageResult = Schema.Struct({
  success: Schema.Literal(true),
  data: Schema.Struct({
    planName: Schema.optional(Schema.String),
    billingCycleReset: Schema.optional(Schema.String),
    overagesEnabled: Schema.optional(Schema.Boolean),
    usageBreakdowns: Schema.Array(
      Schema.Struct({
        displayName: Schema.String,
        used: Schema.Finite,
        limit: Schema.Finite,
        currentOverages: Schema.optional(Schema.Finite),
        overageCharges: Schema.optional(Schema.NullOr(Schema.Finite)),
        currency: Schema.optional(Schema.String),
        hasLimit: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
});
const decodeKiroUsageResult = Schema.decodeUnknownOption(KiroUsageResult);

const credits = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** `2026-12-01` is the UTC day Kiro's billing cycle resets. */
function resetsAt(day: string | undefined): string | undefined {
  if (day === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  return Option.getOrUndefined(
    Option.map(DateTime.make(`${day}T00:00:00.000Z`), DateTime.formatIso),
  );
}

/** A positive whole number of credits from the instance's overage limit setting. */
export function parseKiroOverageLimit(value: string | undefined): number | undefined {
  const parsed = Number((value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Reads `_kiro/account/getUsage`, which Kiro's own `/usage` shows. The credits window
 * names the used and included amounts; with overages on, a second window counts
 * credits past the plan against the user's overage limit, which Kiro does not report.
 */
export function kiroUsageLimits(
  result: unknown,
  checkedAt: string,
  overageLimit: number | undefined,
): { readonly usageLimits: ServerProviderUsageLimits; readonly planName?: string } | undefined {
  const data = Option.getOrUndefined(decodeKiroUsageResult(result))?.data;
  const breakdown = data?.usageBreakdowns.find((entry) =>
    /^credits?$/i.test(entry.displayName.trim()),
  );
  if (data === undefined || breakdown === undefined || breakdown.limit <= 0) return undefined;
  const reset = resetsAt(data.billingCycleReset);
  const windows: Array<ServerProviderUsageWindow> = [
    {
      id: KIRO_CREDITS_WINDOW_ID,
      kind: "monthly",
      label: `Credits · ${credits.format(breakdown.used)} / ${credits.format(breakdown.limit)}`,
      usedPercent: clampPercent((breakdown.used / breakdown.limit) * 100),
      ...(reset === undefined ? {} : { resetsAt: reset }),
    },
  ];
  if (data.overagesEnabled === true) {
    const used = Math.max(0, breakdown.currentOverages ?? 0);
    const charges = money(breakdown.overageCharges ?? 0, breakdown.currency ?? "USD");
    windows.push({
      id: KIRO_OVERAGE_WINDOW_ID,
      kind: "monthly",
      label:
        overageLimit === undefined
          ? `Overage · ${credits.format(used)} credits · ${charges}`
          : `Overage · ${credits.format(used)} / ${credits.format(overageLimit)} · ${charges}`,
      usedPercent: overageLimit === undefined ? 0 : clampPercent((used / overageLimit) * 100),
      ...(reset === undefined ? {} : { resetsAt: reset }),
    });
  }
  const planName = data.planName?.trim();
  return {
    usageLimits: makeUsageLimits({ checkedAt, windows }),
    ...(planName && planName !== "Unknown" ? { planName } : {}),
  };
}
