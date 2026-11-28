import { Toolbar } from "@base-ui/react/toolbar";
import { type ProviderInstanceId } from "@t3tools/contracts";
import { memo, type Dispatch, type SetStateAction, useLayoutEffect, useRef, useState } from "react";
import { msg, T, useMessages } from "gt-react";
import { StarIcon } from "lucide-react";
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

const ModelPickerSidebarItem = memo(function ModelPickerSidebarItem(props: {
  entry: ProviderInstanceEntry;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  selected: boolean;
  hovered: boolean;
  disabledInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  selectableUnavailableInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  getDisabledInstanceTooltip: ((entry: ProviderInstanceEntry) => string) | undefined;
  messageResolver: MessageResolver;
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  setHoveredInstanceId: Dispatch<SetStateAction<ProviderInstanceId | null>>;
}) {
  const isUnavailable = !isProviderInstancePickerReady(props.entry);
  const isContextDisabled = props.disabledInstanceIds?.has(props.entry.instanceId) ?? false;
  const unavailableSelectionIsReachable =
    props.selectableUnavailableInstanceIds?.has(props.entry.instanceId) ?? false;
  const isDisabled = (isUnavailable && !unavailableSelectionIsReachable) || isContextDisabled;
  const showInstanceBadge = shouldShowInstanceBadge(props.entry, props.instanceEntries);
  const tooltip = isUnavailable
    ? describeUnavailableInstance(props.entry, props.messageResolver)
    : isContextDisabled
      ? (props.getDisabledInstanceTooltip?.(props.entry) ?? props.entry.displayName)
      : props.entry.displayName;

  const button = (
    <Toolbar.Button
      className={cn(
        "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none",
        isDisabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
      )}
      data-provider-accent-color={props.entry.accentColor}
      onClick={() => !isDisabled && props.onSelectInstance(props.entry.instanceId)}
      onMouseEnter={() => props.setHoveredInstanceId(props.entry.instanceId)}
      onMouseLeave={() =>
        props.setHoveredInstanceId((current) =>
          current === props.entry.instanceId ? null : current,
        )
      }
      onFocus={() => props.setHoveredInstanceId(props.entry.instanceId)}
      onBlur={() =>
        props.setHoveredInstanceId((current) =>
          current === props.entry.instanceId ? null : current,
        )
      }
      disabled={isDisabled}
      focusableWhenDisabled={!isDisabled}
      aria-pressed={props.selected}
      type="button"
      aria-label={isUnavailable || isContextDisabled ? tooltip : props.entry.displayName}
    >
      <ProviderInstanceIcon
        driverKind={props.entry.driverKind}
        displayName={props.entry.displayName}
        accentColor={props.entry.accentColor}
        acpRegistryAgentId={props.entry.acpRegistryAgentId}
        acpRegistryIconUrl={props.entry.acpRegistryIconUrl}
        showBadge={showInstanceBadge}
        className="size-6 z-30"
        iconClassName="size-5"
        indicatorBackground={
          props.hovered && !isDisabled
            ? "var(--muted)"
            : props.selected
              ? "var(--background)"
              : "color-mix(in oklab, var(--muted) 30%, transparent)"
        }
        {...(props.entry.accentColor ? { badgeClassName: "h-3 min-w-3 px-0.5 text-5xs" } : {})}
      />
    </Toolbar.Button>
  );

  const trigger = isDisabled ? <span className="relative block w-full">{button}</span> : button;

  return (
    <div className="relative w-full" data-model-picker-provider={props.entry.instanceId}>
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
});

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedInstanceId: ProviderInstanceId | "favorites";
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  onFocusSearch: () => void;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  showFavorites?: boolean;
  docked?: boolean;
  disabledInstanceIds?: ReadonlySet<ProviderInstanceId>;
  selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId>;
  getDisabledInstanceTooltip?: (entry: ProviderInstanceEntry) => string;
}) {
  const m = useMessages();
  const showFavorites = props.showFavorites ?? true;
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
    // Adding, removing or reordering providers moves the selected item, so the indicator re-measures.
    props.instanceEntries,
    props.selectedInstanceId,
    showFavorites,
  ]);

  return (
    <Toolbar.Root
      className={cn("w-11 shrink-0 overflow-hidden", !props.docked && "bg-muted/30")}
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
      <div
        className={cn(
          "h-full overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          !props.docked && "overscroll-contain",
        )}
      >
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
                        onClick={() => props.onSelectInstance("favorites")}
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

          {props.instanceEntries.map((entry) => (
            <ModelPickerSidebarItem
              key={entry.instanceId}
              entry={entry}
              instanceEntries={props.instanceEntries}
              selected={props.selectedInstanceId === entry.instanceId}
              hovered={hoveredInstanceId === entry.instanceId}
              disabledInstanceIds={props.disabledInstanceIds}
              selectableUnavailableInstanceIds={props.selectableUnavailableInstanceIds}
              getDisabledInstanceTooltip={props.getDisabledInstanceTooltip}
              messageResolver={m}
              onSelectInstance={props.onSelectInstance}
              setHoveredInstanceId={setHoveredInstanceId}
            />
          ))}
        </div>
      </div>
    </Toolbar.Root>
  );
});
