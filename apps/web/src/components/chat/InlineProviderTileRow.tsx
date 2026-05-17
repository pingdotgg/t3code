import { type ProviderInstanceId } from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { SparklesIcon, StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";

function describeUnavailableInstance(entry: ProviderInstanceEntry): string {
  const label = entry.displayName;
  if (entry.status === "ready") {
    return label;
  }
  const kind =
    entry.status === "error"
      ? "Unavailable"
      : entry.status === "warning"
        ? "Limited"
        : entry.status === "disabled"
          ? "Disabled in settings"
          : "Not ready";
  const msg = entry.snapshot.message?.trim();
  return msg ? `${label} — ${kind}. ${msg}` : `${label} — ${kind}.`;
}

function hasSelectableModels(entry: ProviderInstanceEntry): boolean {
  return entry.status === "ready" || (entry.status === "warning" && entry.models.length > 0);
}

const SELECTED_BUTTON_CLASS = "bg-background text-foreground shadow-sm";
const SELECTED_INDICATOR_CLASS =
  "pointer-events-none absolute -bottom-1 left-1/2 z-10 h-0.5 w-5 -translate-x-1/2 rounded-t-full bg-primary";
const BADGE_BASE_CLASS =
  "pointer-events-none absolute -right-0.5 top-0.5 z-10 flex size-3.5 items-center justify-center rounded-full bg-transparent shadow-sm ";
const NEW_BADGE_CLASS = `${BADGE_BASE_CLASS} text-amber-600  dark:text-amber-300 `;

const PICKER_TOOLTIP_SIDE = "bottom" as const;
const PICKER_TOOLTIP_CLASS = "max-w-64 text-balance font-normal leading-snug";
const ACP_DRIVER_PREFIX = "acp-";

type ProviderTileRowItem =
  | { readonly _tag: "entry"; readonly key: string; readonly entry: ProviderInstanceEntry }
  | { readonly _tag: "separator"; readonly key: string };

export const InlineProviderTileRow = memo(function InlineProviderTileRow(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  /**
   * Instance entries to render as tiles. Each entry becomes one icon keyed
   * by `instanceId`, so the default built-in Codex and a user-authored
   * `codex_personal` appear as two distinct tiles, each routing to their
   * own model list.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** Render the favorites tile. Hidden for locked-provider instance switching. */
  showFavorites?: boolean;
  /**
   * Instance id values that should render the "new" sparkle badge. Callers
   * pass the subset of default built-in ids they want flagged (custom
   * instances are never flagged — the user just made them).
   */
  newBadgeInstanceIds?: ReadonlySet<ProviderInstanceId>;
}) {
  const handleSelect = (instanceId: ProviderInstanceId | "favorites") => {
    props.onSelectInstance(instanceId);
  };
  const showFavorites = props.showFavorites ?? true;
  const duplicateDriverCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of props.instanceEntries) {
      counts.set(entry.driverKind, (counts.get(entry.driverKind) ?? 0) + 1);
    }
    return counts;
  }, [props.instanceEntries]);
  const tileItems = useMemo(() => {
    const builtInEntries: ProviderInstanceEntry[] = [];
    const acpEntries: ProviderInstanceEntry[] = [];
    for (const entry of props.instanceEntries) {
      if (entry.driverKind.startsWith(ACP_DRIVER_PREFIX)) {
        acpEntries.push(entry);
      } else {
        builtInEntries.push(entry);
      }
    }

    const items: ProviderTileRowItem[] = builtInEntries.map((entry, index) => ({
      _tag: "entry",
      key: `built-in:${entry.instanceId}:${index}`,
      entry,
    }));
    if (builtInEntries.length > 0 && acpEntries.length > 0) {
      items.push({ _tag: "separator", key: "built-in-acp-separator" });
    }
    items.push(
      ...acpEntries.map(
        (entry, index) =>
          ({
            _tag: "entry",
            key: `acp:${entry.instanceId}:${index}`,
            entry,
          }) satisfies ProviderTileRowItem,
      ),
    );
    return items;
  }, [props.instanceEntries]);

  return (
    <div
      className="w-full shrink-0 overflow-x-auto border-b bg-muted/30 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-model-picker-tile-row="true"
    >
      <div className="flex w-max items-center gap-1 p-1">
        {/* Favorites section */}
        {showFavorites ? (
          <div className="mr-1 border-r pr-1">
            <div className="relative">
              {props.selectedInstanceId === "favorites" && (
                <div className={SELECTED_INDICATOR_CLASS} />
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      className={cn(
                        "relative isolate flex aspect-square size-9 shrink-0 cursor-pointer items-center justify-center rounded transition-colors hover:bg-muted",
                        props.selectedInstanceId === "favorites" && SELECTED_BUTTON_CLASS,
                      )}
                      onClick={() => handleSelect("favorites")}
                      type="button"
                      data-model-picker-provider="favorites"
                      aria-label="Favorites"
                    >
                      <StarIcon className="size-5 shrink-0 fill-current" aria-hidden />
                    </button>
                  }
                />
                <TooltipPopup
                  side={PICKER_TOOLTIP_SIDE}
                  align="center"
                  className={PICKER_TOOLTIP_CLASS}
                >
                  Favorites
                </TooltipPopup>
              </Tooltip>
            </div>
          </div>
        ) : null}

        {/* Instance buttons (grouped by built-in drivers, then ACP registry agents) */}
        {tileItems.map((item) => {
          if (item._tag === "separator") {
            return (
              <div
                key={item.key}
                role="separator"
                aria-orientation="vertical"
                data-model-picker-provider-separator="built-in-acp"
                className="mx-1 h-7 w-px shrink-0 bg-border"
              />
            );
          }

          const entry = item.entry;
          const isDisabled = !entry.isAvailable || !hasSelectableModels(entry);
          const isSelected = props.selectedInstanceId === entry.instanceId;
          const showNewBadge = props.newBadgeInstanceIds?.has(entry.instanceId) ?? false;
          const showInstanceBadge =
            Boolean(entry.accentColor) || (duplicateDriverCounts.get(entry.driverKind) ?? 0) > 1;

          const tooltip = isDisabled
            ? describeUnavailableInstance(entry)
            : showNewBadge
              ? `${entry.displayName} — New`
              : entry.displayName;

          const button = (
            <button
              data-model-picker-provider={entry.instanceId}
              className={cn(
                "relative isolate flex aspect-square size-9 shrink-0 cursor-pointer items-center justify-center rounded transition-colors hover:bg-muted",
                isSelected && SELECTED_BUTTON_CLASS,
                isDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
              )}
              data-provider-accent-color={entry.accentColor}
              onClick={() => !isDisabled && handleSelect(entry.instanceId)}
              disabled={isDisabled}
              type="button"
              aria-label={
                isDisabled
                  ? tooltip
                  : showNewBadge
                    ? `${entry.displayName}, new`
                    : entry.displayName
              }
            >
              <ProviderInstanceIcon
                driverKind={entry.driverKind}
                displayName={entry.displayName}
                accentColor={entry.accentColor}
                showBadge={showInstanceBadge}
                className="size-6"
                iconClassName="size-5"
              />
              {showNewBadge ? (
                <span className={NEW_BADGE_CLASS} aria-hidden>
                  <SparklesIcon className="size-2" />
                </span>
              ) : null}
            </button>
          );

          const trigger = isDisabled ? <span className="relative block">{button}</span> : button;

          return (
            <div key={item.key} className="relative">
              {isSelected && <div className={SELECTED_INDICATOR_CLASS} />}
              <Tooltip>
                <TooltipTrigger render={trigger} />
                <TooltipPopup
                  side={PICKER_TOOLTIP_SIDE}
                  align="center"
                  className={PICKER_TOOLTIP_CLASS}
                >
                  {tooltip}
                </TooltipPopup>
              </Tooltip>
            </div>
          );
        })}

        {/* No "coming soon" tiles — Gemini & GitHub Copilot are now
            installable via the merged ACP Registry section in Settings. */}
      </div>
    </div>
  );
});
