import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

export const WidgetPeriod = Schema.Literals(["all", "session", "weekly", "monthly", "tightest"]);
const WidgetResetDisplay = Schema.Literals(["reset", "both", "remaining"]);
export const SubscriptionWidgetConfiguration = Schema.Struct({
  providers: Schema.Array(Schema.Literals(["codex", "claudeAgent"])),
  accountIds: Schema.NullOr(Schema.Array(Schema.String)),
  environmentIds: Schema.NullOr(Schema.Array(Schema.String)),
  grouping: Schema.Literals(["accounts", "pooled"]),
  codexPeriod: WidgetPeriod,
  claudePeriod: WidgetPeriod,
  sort: Schema.Literals(["provider", "name", "remaining", "reset"]),
  density: Schema.Literals(["comfortable", "compact"]),
  windowsPerAccount: Schema.Literals([0, 1, 2, 3]),
  percentage: Schema.Literals(["remaining", "used"]),
  theme: Schema.Literals(["system", "light", "dark"]),
  showBars: Schema.Boolean,
  showResetTimes: Schema.Boolean,
  resetDisplay: WidgetResetDisplay.pipe(Schema.withDecodingDefault(Effect.succeed("reset"))),
  quotaResetDisplays: Schema.Record(Schema.String, WidgetResetDisplay).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  showEnvironment: Schema.Literals(["auto", true, false]).pipe(
    Schema.withDecodingDefault(Effect.succeed("auto")),
  ),
  showUpdatedAt: Schema.Boolean,
});
export type SubscriptionWidgetConfiguration = typeof SubscriptionWidgetConfiguration.Type;

export const DEFAULT_WIDGET_CONFIGURATION: SubscriptionWidgetConfiguration = {
  providers: ["codex", "claudeAgent"],
  accountIds: null,
  environmentIds: null,
  grouping: "accounts",
  codexPeriod: "all",
  claudePeriod: "all",
  sort: "provider",
  density: "comfortable",
  windowsPerAccount: 0,
  percentage: "remaining",
  theme: "system",
  showBars: true,
  showResetTimes: true,
  resetDisplay: "reset",
  quotaResetDisplays: {},
  showEnvironment: "auto",
  showUpdatedAt: true,
};

const WidgetPreferences = Schema.Struct({
  defaults: SubscriptionWidgetConfiguration,
  widgets: Schema.Record(Schema.String, SubscriptionWidgetConfiguration),
});
export type SubscriptionWidgetPreferences = typeof WidgetPreferences.Type;
const decodePreferences = Schema.decodeUnknownOption(WidgetPreferences);

export function resolveWidgetPreferences(value: unknown): SubscriptionWidgetPreferences {
  return Option.getOrElse(decodePreferences(value), () => ({
    defaults: DEFAULT_WIDGET_CONFIGURATION,
    widgets: {},
  }));
}

export function toggleWidgetSelection(
  selected: readonly string[] | null,
  available: readonly string[],
  id: string,
) {
  const next = new Set(selected ?? available);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return [...next];
}
