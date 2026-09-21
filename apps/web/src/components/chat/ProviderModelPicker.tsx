import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo, useEffect, useMemo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { Badge } from "../ui/badge";
import { buttonVariants } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ModelPickerContent, resolveModelPickerSelectedModel } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  ModelEsque,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import {
  ComposerControl,
  ComposerControlChevron,
  type ComposerControlSize,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { shortcutLabelForCommand } from "../../keybindings";

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  /**
   * The instance currently selected in the composer. Drives the trigger
   * icon, label and the default-highlighted combobox row.
   */
  activeInstanceId: ProviderInstanceId;
  model: string;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** Instance entries rendered in the sidebar + used to resolve display name. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  instanceIndicatorBackground?: string;
  size?: ComposerControlSize;
  isComposerOwned?: boolean;
  disabled?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  /** Aggregate settings can show a neutral value without claiming one provider is selected. */
  triggerLabel?: string;
  triggerAriaLabel?: string;
  onOpenChange?: (open: boolean) => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const size = props.size ?? "sm";

  // Resolve the active instance entry by exact routing key. The composer
  // resolves fallbacks before rendering this component; if the selected
  // instance disappears, do not infer a replacement from its driver kind.
  const activeEntry = useMemo(() => {
    return (
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null
    );
  }, [props.activeInstanceId, props.instanceEntries]);

  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  // Account-specific catalogs must keep the selected model label while unavailable.
  const selectedModel =
    resolveModelPickerSelectedModel({
      driverKind: activeEntry?.driverKind,
      model: props.model,
      options: selectedInstanceOptions,
    }) ??
    (activeEntry?.driverKind === "opencode" || activeEntry?.driverKind === "antigravity"
      ? undefined
      : selectedInstanceOptions[0]);
  const triggerTitle = selectedModel
    ? getTriggerDisplayModelName(selectedModel)
    : props.model === ANTIGRAVITY_DEFAULT_MODEL
      ? "Choose model"
      : props.model || "Choose model";
  const triggerLabel = selectedModel
    ? `${getTriggerDisplayModelLabel(selectedModel)}${selectedModel.isUnavailable ? " (Unavailable)" : ""}`
    : triggerTitle;
  const showInstanceBadge =
    activeEntry !== null && shouldShowInstanceBadge(activeEntry, props.instanceEntries);

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const { documentElement, body } = document;
    const previousDocumentOverscrollBehavior = documentElement.style.overscrollBehavior;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

    documentElement.style.overscrollBehavior = "contain";
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const shouldAllowOverlayScroll = (target: EventTarget | null) => {
      return target instanceof Element && target.closest("[data-model-picker-content]");
    };
    const preventBackgroundWheel = (event: WheelEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };
    const preventBackgroundTouchMove = (event: TouchEvent) => {
      if (shouldAllowOverlayScroll(event.target)) {
        return;
      }
      event.preventDefault();
    };

    document.addEventListener("wheel", preventBackgroundWheel, { capture: true, passive: false });
    document.addEventListener("touchmove", preventBackgroundTouchMove, {
      capture: true,
      passive: false,
    });

    return () => {
      document.removeEventListener("wheel", preventBackgroundWheel, { capture: true });
      document.removeEventListener("touchmove", preventBackgroundTouchMove, { capture: true });
      documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior;
      body.style.overflow = previousBodyOverflow;
      body.style.paddingRight = previousBodyPaddingRight;
    };
  }, [isMenuOpen]);

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  const shortcutLabel = props.keybindings
    ? shortcutLabelForCommand(props.keybindings, "modelPicker.toggle")
    : null;
  const selectedEntries = props.selectedModels?.map((selection) => {
    const entry = props.instanceEntries.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    const model = resolveModelPickerSelectedModel({
      driverKind: entry?.driverKind,
      model: selection.model,
      options: props.modelOptionsByInstance.get(selection.instanceId) ?? [],
    });
    return {
      ...selection,
      entry,
      label: model
        ? `${getTriggerDisplayModelName(model)}${model.isUnavailable ? " (Unavailable)" : ""}`
        : selection.model,
    };
  });
  const multipleLabel = selectedEntries
    ? selectedEntries.length === 0
      ? "Choose models"
      : `${selectedEntries
          .slice(0, 2)
          .map((selection) => selection.label)
          .join(", ")}${selectedEntries.length > 2 ? `, ${selectedEntries.length - 2} more` : ""}`
    : undefined;
  const allModelNames = selectedEntries
    ? selectedEntries.map((selection) => selection.label).join(", ") || "Choose models"
    : undefined;
  const triggerTooltipContent = shortcutLabel
    ? `${props.triggerLabel ?? allModelNames ?? triggerLabel} (${shortcutLabel})`
    : (props.triggerLabel ?? allModelNames ?? triggerLabel);

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <PopoverTrigger
        render={
          <ComposerControl
            aria-label={props.triggerAriaLabel ?? allModelNames}
            variant={props.triggerVariant ?? "ghost"}
            size={size}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 shrink justify-between whitespace-nowrap",
              !props.isComposerOwned && "max-w-48 sm:max-w-56",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn("flex min-w-0 flex-1 items-center", size === "xs" ? "gap-1" : "gap-1.5")}
        >
          {selectedEntries && props.triggerLabel === undefined ? (
            <span className="flex shrink-0 items-center -space-x-1" aria-hidden="true">
              {selectedEntries
                .slice(0, 3)
                .map((selection) =>
                  selection.entry ? (
                    <ProviderInstanceIcon
                      key={`${selection.instanceId}:${selection.model}`}
                      driverKind={selection.entry.driverKind}
                      displayName={selection.entry.displayName}
                      accentColor={selection.entry.accentColor}
                      className="size-4 rounded-full bg-[var(--chat-composer-glass-surface,var(--background))] ring-2 ring-[var(--chat-composer-glass-surface,var(--background))]"
                      iconClassName="size-4"
                    />
                  ) : null,
                )}
              {selectedEntries.length > 3 ? (
                <span className="relative z-30 flex size-4 items-center justify-center rounded-full bg-[var(--chat-composer-glass-surface,var(--background))] text-[9px] ring-2 ring-[var(--chat-composer-glass-surface,var(--background))]">
                  +{selectedEntries.length - 3}
                </span>
              ) : null}
            </span>
          ) : activeEntry && props.triggerLabel === undefined ? (
            <ProviderInstanceIcon
              driverKind={activeEntry.driverKind}
              displayName={activeEntry.displayName}
              accentColor={activeEntry.accentColor}
              showBadge={showInstanceBadge}
              className="size-4"
              iconClassName={cn("size-4", props.activeProviderIconClassName)}
              indicatorBackground={props.instanceIndicatorBackground ?? "var(--contrast-input)"}
              badgeClassName={cn(
                "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]",
                size === "xs" && "shadow-none",
              )}
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className="min-w-0 flex-1 overflow-hidden truncate"
                  data-chat-provider-model-picker-label="true"
                />
              }
            >
              {props.triggerLabel ?? multipleLabel ?? triggerTitle}
            </TooltipTrigger>
            <TooltipPopup side="top">{triggerTooltipContent}</TooltipPopup>
          </Tooltip>
          {selectedModel?.isUnavailable && !selectedEntries && props.triggerLabel === undefined ? (
            <Badge variant="outline" size="sm">
              Unavailable
            </Badge>
          ) : null}
        </span>
        <span aria-hidden="true" className="flex items-center">
          <ComposerControlChevron size={size} />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        {...(props.isComposerOwned ? composerFloatingLayerProps : {})}
        align="start"
        className="before:hidden [--viewport-inline-padding:0]"
        viewportClassName="overflow-hidden! rounded-[calc(var(--radius-lg)-1px)] p-0 [clip-path:inset(0_round_calc(var(--radius-lg)-1px))]"
      >
        <ModelPickerContent
          activeInstanceId={activeInstanceId}
          model={props.model}
          {...(props.selectedModels !== undefined ? { selectedModels: props.selectedModels } : {})}
          {...(props.onToggleModel
            ? {
                onToggleModel: (instanceId: ProviderInstanceId, model: string) => {
                  if (!props.disabled) props.onToggleModel?.(instanceId, model);
                },
              }
            : {})}
          lockedProvider={props.lockedProvider}
          lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
          instanceEntries={props.instanceEntries}
          {...(props.keybindings ? { keybindings: props.keybindings } : {})}
          modelOptionsByInstance={props.modelOptionsByInstance}
          terminalOpen={props.terminalOpen ?? false}
          onRequestClose={() => setIsMenuOpen(false)}
          {...(props.onOpenProviderSetup ? { onOpenProviderSetup: props.onOpenProviderSetup } : {})}
          {...(props.getModelDisabledReason
            ? { getModelDisabledReason: props.getModelDisabledReason }
            : {})}
          onInstanceModelChange={handleInstanceModelChange}
        />
      </PopoverPopup>
    </Popover>
  );
});
