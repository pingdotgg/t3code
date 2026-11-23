import { Toolbar } from "@base-ui/react/toolbar";
import { type ProviderInstanceId } from "@t3tools/contracts";
import {
  MODEL_VENDOR_IDS,
  modelVendorDisplayName,
  modelVendorTabId,
  type ModelVendorId,
  type ModelVendorTabId,
  type VendorQuotaSummary,
} from "@t3tools/shared/modelVendorQuota";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { msg, T, useGT, useMessages } from "gt-react";
import { StarIcon } from "lucide-react";
import { VendorBrandIcon } from "./ModelPickerQuotaPanel";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import type { MessageResolver } from "../../i18n/messages";
import {
  isProviderInstancePickerReady,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";

function describeUnavailableInstance(
  entry: ProviderInstanceEntry,
  resolve: MessageResolver,
): string {
  const label = entry.displayName;
  // An unavailable instance (a driver this build lacks or the policy leaves out) says why instead.
  if ((!entry.enabled && entry.isAvailable) || entry.status === "disabled") {
    return resolve(msg("{label}: Disabled in settings.", { label }));
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const message = entry.snapshot.message?.trim();
  if (message) {
    return resolve(
      entry.status === "error"
        ? msg("{label}: Unavailable. {message}", { label, message })
        : entry.status === "warning"
          ? msg("{label}: Limited. {message}", { label, message })
          : msg("{label}: Not ready. {message}", { label, message }),
    );
  }
  return resolve(
    entry.status === "error"
      ? msg("{label}: Unavailable.", { label })
      : entry.status === "warning"
        ? msg("{label}: Limited.", { label })
        : msg("{label}: Not ready.", { label }),
  );
}

const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;

export type ModelPickerSidebarSelection = ProviderInstanceId | "favorites" | ModelVendorTabId;

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ModelPickerSidebarSelection;
  onSelectInstance: (instanceId: ModelPickerSidebarSelection) => void;
  onFocusSearch: () => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  showFavorites?: boolean;
  showVendorTabs?: boolean;
  visibleVendorIds?: ReadonlyArray<ModelVendorId>;
  vendorQuotas?: Readonly<Record<ModelVendorId, VendorQuotaSummary>>;
  disabledVendorTabs?: ReadonlySet<ModelVendorTabId>;
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
}) {
  const gt = useGT();
  const m = useMessages();
  const handleSelect = (instanceId: ModelPickerSidebarSelection) => {
    props.onSelectInstance(instanceId);
  };
  const showFavorites = props.showFavorites ?? true;
  const visibleVendorIds = props.visibleVendorIds ?? MODEL_VENDOR_IDS;
  const showVendorTabs = (props.showVendorTabs ?? true) && visibleVendorIds.length > 0;
  const [hoveredInstanceId, setHoveredInstanceId] = useState<ProviderInstanceId | null>(null);
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const [selectedIndicatorTop, setSelectedIndicatorTop] = useState<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the selected provider item's DOM offset to position the selection indicator
  useLayoutEffect(() => {
    const content = sidebarContentRef.current;
    if (!content) {
      return;
    }
    const selectedItem = Array.from(
      content.querySelectorAll<HTMLElement>("[data-model-picker-provider]"),
    ).find((item) => item.dataset.modelPickerProvider === props.selectedInstanceId);
    if (!selectedItem) {
      setSelectedIndicatorTop(null);
      return;
    }
    setSelectedIndicatorTop(selectedItem.offsetTop + selectedItem.offsetHeight / 2 - 10);
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Adding, removing or reordering providers moves the selected item, so the indicator re-measures.
    props.instanceEntries,
    props.selectedInstanceId,
    showFavorites,
  ]);

  return (
    <Toolbar.Root
      className="w-11 shrink-0 overflow-hidden bg-muted/30"
      data-model-picker-sidebar="true"
      aria-label={m(msg("Providers"))}
      orientation="vertical"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onFocusSearch();
          return;
        }
      }}
    >
      <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={sidebarContentRef} className="relative flex min-h-full flex-col gap-1 p-1">
          {selectedIndicatorTop !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className="pointer-events-none absolute right-1 z-10 h-5 w-0.75 rounded-full bg-primary transition-[top] duration-200 ease-out"
              style={{ top: selectedIndicatorTop }}
            />
          ) : null}
          {showFavorites ? (
            <>
              <div className="relative w-full" data-model-picker-provider="favorites">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Toolbar.Button
                        className={cn(
                          "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none",
                        )}
                        onClick={() => handleSelect("favorites")}
                        type="button"
                        aria-label={m(msg("Favorites"))}
                        aria-pressed={props.selectedInstanceId === "favorites"}
                      >
                        <StarIcon className="size-5 fill-current shrink-0" aria-hidden />
                      </Toolbar.Button>
                    }
                  />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                  >
                    <T>Favorites</T>
                  </TooltipPopup>
                </Tooltip>
              </div>
              <div className="border-b border-border/70" aria-hidden="true" />
            </>
          ) : null}

          {showVendorTabs ? (
            <>
              {visibleVendorIds.map((vendor) => {
                const tabId = modelVendorTabId(vendor);
                const isDisabled = props.disabledVendorTabs?.has(tabId) ?? false;
                const isSelected = props.selectedInstanceId === tabId;
                const quota = props.vendorQuotas?.[vendor];
                const minRemaining = quota?.minRemainingPercent ?? null;
                const displayName = modelVendorDisplayName(vendor);
                const vendorTitle =
                  vendor === "claude" && quota?.viaAntigravityOnly
                    ? gt("{vendor} (Antigravity)", { vendor: displayName })
                    : vendor === "gemini"
                      ? gt("Gemini (Antigravity)")
                      : displayName;
                const tooltip =
                  minRemaining !== null
                    ? gt("{vendor} · {remaining}% left", {
                        vendor: vendorTitle,
                        remaining: minRemaining,
                      })
                    : vendorTitle;
                const dotColor =
                  minRemaining !== null && minRemaining <= 10
                    ? "bg-destructive"
                    : minRemaining !== null && minRemaining <= 20
                      ? "bg-warning"
                      : null;

                const button = (
                  <Toolbar.Button
                    className={cn(
                      "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none",
                      isDisabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
                    )}
                    onClick={() => !isDisabled && handleSelect(tabId)}
                    disabled={isDisabled}
                    focusableWhenDisabled={!isDisabled}
                    aria-pressed={isSelected}
                    type="button"
                    aria-label={tooltip}
                  >
                    <VendorBrandIcon vendor={vendor} className="size-5" />
                    {dotColor ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          "pointer-events-none absolute right-1 bottom-1 size-1.5 rounded-full ring-1 ring-background",
                          dotColor,
                        )}
                      />
                    ) : null}
                  </Toolbar.Button>
                );

                return (
                  <div key={tabId} className="relative w-full" data-model-picker-provider={tabId}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          isDisabled ? (
                            <span className="relative block w-full">{button}</span>
                          ) : (
                            button
                          )
                        }
                      />
                      <TooltipPopup
                        side={PICKER_TOOLTIP_SIDE}
                        sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                        align="center"
                      >
                        {tooltip}
                      </TooltipPopup>
                    </Tooltip>
                  </div>
                );
              })}
              {props.instanceEntries.length > 0 ? (
                <div className="border-b border-border/70" aria-hidden="true" />
              ) : null}
            </>
          ) : null}

          {props.instanceEntries.map((entry) => {
            const isUnavailable = !isProviderInstancePickerReady(entry);
            const isContextDisabled = props.disabledInstanceIds?.has(entry.instanceId) ?? false;
            const unavailableSelectionIsReachable =
              props.selectableUnavailableInstanceIds?.has(entry.instanceId) ?? false;
            const isDisabled =
              (isUnavailable && !unavailableSelectionIsReachable) || isContextDisabled;
            const isSelected = props.selectedInstanceId === entry.instanceId;
            const isHovered = hoveredInstanceId === entry.instanceId;
            const showInstanceBadge = shouldShowInstanceBadge(entry, props.instanceEntries);

            const tooltip = isUnavailable
              ? describeUnavailableInstance(entry, m)
              : isContextDisabled
                ? (props.getDisabledInstanceTooltip?.(entry) ?? entry.displayName)
                : entry.displayName;

            const button = (
              <Toolbar.Button
                className={cn(
                  "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none",
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
                focusableWhenDisabled={!isDisabled}
                aria-pressed={isSelected}
                type="button"
                aria-label={isUnavailable || isContextDisabled ? tooltip : entry.displayName}
              >
                <ProviderInstanceIcon
                  driverKind={entry.driverKind}
                  displayName={entry.displayName}
                  accentColor={entry.accentColor}
                  acpRegistryAgentId={entry.acpRegistryAgentId}
                  acpRegistryIconUrl={entry.acpRegistryIconUrl}
                  showBadge={showInstanceBadge}
                  className="size-6 z-30"
                  iconClassName="size-5"
                  indicatorBackground={
                    isHovered && !isDisabled
                      ? "var(--muted)"
                      : isSelected
                        ? "var(--background)"
                        : "color-mix(in oklab, var(--muted) 30%, transparent)"
                  }
                  {...(entry.accentColor ? { badgeClassName: "h-3 min-w-3 px-0.5 text-5xs" } : {})}
                />
              </Toolbar.Button>
            );

            const trigger = isDisabled ? (
              <span className="relative block w-full">{button}</span>
            ) : (
              button
            );

            return (
              <div
                key={entry.instanceId}
                className="relative w-full"
                data-model-picker-provider={entry.instanceId}
              >
                <Tooltip>
                  <TooltipTrigger render={trigger} />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                  >
                    {tooltip}
                  </TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    </Toolbar.Root>
  );
});
