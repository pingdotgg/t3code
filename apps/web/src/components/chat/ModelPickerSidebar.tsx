import { type ProviderInstanceId } from "@t3tools/contracts";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SparklesIcon, StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";

/**
 * Build the hover tooltip for an instance button. Mirrors the old
 * kind-based copy but uses the entry's configured `displayName` so custom
 * instances get their user-authored name (e.g. "Codex Personal — Unavailable.").
 */
function describeUnavailableInstance(entry: ProviderInstanceEntry): string {
  const label = entry.displayName;
  if (!entry.enabled || entry.status === "disabled") {
    return `${label} — Disabled in settings.`;
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const kind =
    entry.status === "error" ? "Unavailable" : entry.status === "warning" ? "Limited" : "Not ready";
  const msg = entry.snapshot.message?.trim();
  return msg ? `${label} — ${kind}. ${msg}` : `${label} — ${kind}.`;
}

const SELECTED_INDICATOR_CLASS =
  "pointer-events-none absolute -right-1 top-1/2 z-10 h-5 w-0.75 -translate-y-1/2 rounded-l-full bg-primary";
const BADGE_BASE_CLASS =
  "pointer-events-none absolute -right-0.5 top-0.5 z-10 flex size-3.5 items-center justify-center rounded-full bg-transparent shadow-sm ";
const NEW_BADGE_CLASS = `${BADGE_BASE_CLASS} text-amber-600  dark:text-amber-300 `;

/** Opens toward the rail so the list stays readable (not over the model names). */
const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;
const PICKER_TOOLTIP_CLASS = "max-w-64 text-balance font-normal leading-snug";

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  /**
   * Instance entries to render as rail buttons. Each entry becomes one icon
   * keyed by `instanceId`, so the default built-in Codex and a user-authored
   * `codex_personal` appear as two distinct rail items, each routing to
   * their own model list.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** Render the favorites rail entry. Hidden for locked-provider instance switching. */
  showFavorites?: boolean;
  /** Instance ids shown in the rail but unavailable for the current picker context. */
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
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
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorTop, setSelectedIndicatorTop] = useState<number | null>(null);
  const duplicateDriverCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of props.instanceEntries) {
      counts.set(entry.driverKind, (counts.get(entry.driverKind) ?? 0) + 1);
    }
    return counts;
  }, [props.instanceEntries]);

  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) {
      return;
    }
    const selectedButton = Array.from(
      content.querySelectorAll<HTMLElement>("[data-model-picker-provider]"),
    ).find((button) => button.dataset.modelPickerProvider === props.selectedInstanceId);
    if (!selectedButton) {
      setSelectedIndicatorTop(null);
      return;
    }
    const contentRect = content.getBoundingClientRect();
    const selectedButtonRect = selectedButton.getBoundingClientRect();
    setSelectedIndicatorTop(
      selectedButtonRect.top -
        contentRect.top +
        content.scrollTop +
        selectedButtonRect.height / 2 -
        10,
    );
  }, [props.instanceEntries, props.selectedInstanceId, showFavorites]);

  return (
    <div className="w-12 shrink-0 overflow-hidden bg-muted/60" data-model-picker-sidebar="true">
      <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div
          ref={sidebarContentRef}
          className="relative flex min-h-full flex-col gap-1 px-1 pb-1 pt-0.5"
        >
          {selectedIndicatorTop !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className={cn(
                SELECTED_INDICATOR_CLASS,
                "right-0 translate-y-0 transition-[top] duration-200 ease-out",
              )}
              style={{ top: selectedIndicatorTop }}
            />
          ) : null}
          {/* Favorites section */}
          {showFavorites ? (
            <div className="mb-1 pb-1">
              <div className="relative w-full">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        className={cn(
                          "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-muted",
                        )}
                        onClick={() => handleSelect("favorites")}
                        type="button"
                        data-model-picker-provider="favorites"
                        aria-label="Favorites"
                      >
                        <StarIcon className="size-5 fill-current shrink-0" aria-hidden />
                      </button>
                    }
                  />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                    className={PICKER_TOOLTIP_CLASS}
                  >
                    Favorites
                  </TooltipPopup>
                </Tooltip>
              </div>
            </div>
          ) : null}

          {/* Instance buttons (one per configured instance — built-in + custom) */}
          {props.instanceEntries.map((entry) => {
            const isUnavailable = !isProviderInstancePickerReady(entry);
            const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
            const isDisabled = isUnavailable || isContextDisabled;
            const isSelected = props.selectedInstanceId === entry.instanceId;
            const isHovered = hoveredInstanceId === entry.instanceId;
            const showNewBadge = props.newBadgeInstanceIds?.has(entry.instanceId) ?? false;
            const showInstanceBadge =
              Boolean(entry.accentColor) || (duplicateDriverCounts.get(entry.driverKind) ?? 0) > 1;

            const tooltip = isUnavailable
              ? describeUnavailableInstance(entry)
              : isContextDisabled
                ? (props.getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
                : showNewBadge
                  ? `${entry.displayName} — New`
                  : entry.displayName;

            const button = (
              <button
                data-model-picker-provider={entry.instanceId}
                className={cn(
                  "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-muted",
                  isDisabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
                )}
                data-provider-accent-color={entry.accentColor}
                onClick={() => !isDisabled && handleSelect(entry.instanceId)}
                onMouseEnter={() => setHoveredInstanceId(entry.instanceId)}
                onMouseLeave={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
                onFocus={() => setHoveredInstanceId(entry.instanceId)}
                onBlur={() =>
                  setHoveredInstanceId((current) => (current === entry.instanceId ? null : current))
                }
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
                  indicatorBackground={
                    isHovered && !isDisabled
                      ? "var(--muted)"
                      : isSelected
                        ? "var(--background)"
                        : "color-mix(in oklab, var(--muted) 30%, transparent)"
                  }
                  {...(entry.accentColor
                    ? { badgeClassName: "h-3 min-w-3 px-0.5 text-[7px]" }
                    : {})}
                />
                {showNewBadge ? (
                  <span className={NEW_BADGE_CLASS} aria-hidden>
                    <SparklesIcon className="size-2" />
                  </span>
                ) : null}
              </button>
            );

            const trigger = isDisabled ? (
              <span className="relative block w-full">{button}</span>
            ) : (
              button
            );

            return (
              <div key={entry.instanceId} className="relative w-full">
                <Tooltip>
                  <TooltipTrigger render={trigger} />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                    className={PICKER_TOOLTIP_CLASS}
                  >
                    {tooltip}
                  </TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
