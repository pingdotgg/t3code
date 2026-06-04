import { type ProviderInstanceId } from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { Clock3Icon, SparklesIcon, StarIcon } from "lucide-react";
import { Gemini, GithubCopilotIcon } from "../Icons";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";

/**
 * Build the hover tooltip for an instance button. Mirrors the old
 * kind-based copy but uses the entry's configured `displayName` so custom
 * instances get their user-authored name (e.g. "Codex Personal — Unavailable.").
 */
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

const SELECTED_BUTTON_CLASS = "bg-background text-foreground shadow-sm";
const SELECTED_INDICATOR_CLASS =
  "pointer-events-none absolute -right-1 top-1/2 z-10 h-5 w-0.5 -translate-y-1/2 rounded-l-full bg-primary";
const BADGE_BASE_CLASS =
  "pointer-events-none absolute -right-0.5 top-0.5 z-10 flex size-3.5 items-center justify-center rounded-full bg-transparent shadow-sm ";
const NEW_BADGE_CLASS = `${BADGE_BASE_CLASS} text-amber-600  dark:text-amber-300 `;
const SOON_BADGE_CLASS = `${BADGE_BASE_CLASS} text-muted-foreground `;

/** Opens toward the rail so the list stays readable (not over the model names). */
const PICKER_TOOLTIP_SIDE = "left" as const;
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
  /** Render non-configured coming-soon provider entries. Hidden in scoped rails. */
  showComingSoon?: boolean;
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
  const showComingSoon = props.showComingSoon ?? true;
  const duplicateDriverCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of props.instanceEntries) {
      counts.set(entry.driverKind, (counts.get(entry.driverKind) ?? 0) + 1);
    }
    return counts;
  }, [props.instanceEntries]);

  return (
    <ScrollArea
      hideScrollbars
      scrollFade
      className="w-12 shrink-0 border-r bg-muted/30"
      data-model-picker-sidebar="true"
    >
      <div className="flex min-h-full flex-col gap-1 p-1">
        {/* Favorites section */}
        {showFavorites ? (
          <div className="pb-1 mb-1 border-b">
            <div className="relative w-full">
              {props.selectedInstanceId === "favorites" && (
                <div className={SELECTED_INDICATOR_CLASS} />
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      className={cn(
                        "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded transition-colors hover:bg-muted",
                        props.selectedInstanceId === "favorites" && SELECTED_BUTTON_CLASS,
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
          const isDisabled = !entry.isAvailable || entry.status !== "ready";
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
                "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded transition-colors hover:bg-muted",
                isSelected && SELECTED_BUTTON_CLASS,
                isDisabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
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

          const trigger = isDisabled ? (
            <span className="relative block w-full">{button}</span>
          ) : (
            button
          );

          return (
            <div key={entry.instanceId} className="relative w-full">
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

        {showComingSoon ? (
          <>
            {/* Gemini button (coming soon) */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="relative block w-full">
                    <button
                      className={cn(
                        "relative isolate flex w-full aspect-square items-center justify-center rounded opacity-50 cursor-not-allowed transition-colors hover:bg-transparent",
                      )}
                      disabled
                      type="button"
                      data-model-picker-provider="gemini-coming-soon"
                      aria-label="Gemini — coming soon"
                    >
                      <Gemini className="size-5 text-muted-foreground/85" aria-hidden />
                      <span className={SOON_BADGE_CLASS} aria-hidden>
                        <Clock3Icon className="size-2" />
                      </span>
                    </button>
                  </span>
                }
              />
              <TooltipPopup
                side={PICKER_TOOLTIP_SIDE}
                align="center"
                className={PICKER_TOOLTIP_CLASS}
              >
                Gemini — Coming soon
              </TooltipPopup>
            </Tooltip>
            {/* Github Copilot button (coming soon) */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="relative block w-full">
                    <button
                      className={cn(
                        "relative isolate flex w-full aspect-square items-center justify-center rounded opacity-50 cursor-not-allowed transition-colors hover:bg-transparent",
                      )}
                      disabled
                      type="button"
                      data-model-picker-provider="github-copilot-coming-soon"
                      aria-label="Github Copilot — coming soon"
                    >
                      <GithubCopilotIcon className="size-5 text-muted-foreground/85" aria-hidden />
                      <span className={SOON_BADGE_CLASS} aria-hidden>
                        <Clock3Icon className="size-2" />
                      </span>
                    </button>
                  </span>
                }
              />
              <TooltipPopup
                side={PICKER_TOOLTIP_SIDE}
                align="center"
                className={PICKER_TOOLTIP_CLASS}
              >
                Github Copilot — Coming soon
              </TooltipPopup>
            </Tooltip>
          </>
        ) : null}
      </div>
    </ScrollArea>
  );
});
