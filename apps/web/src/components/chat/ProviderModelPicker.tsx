import { type ProviderInstanceId, type ProviderDriverKind } from "@t3tools/contracts";
import { memo, useEffect, useMemo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  ModelEsque,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils";
import { setModelPickerOpen } from "../../modelPickerOpenState";
import type { ProviderInstanceEntry } from "../../providerInstances";

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  activeInstanceId: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  open?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledIsPanelOpen, setUncontrolledIsPanelOpen] = useState(false);
  const isPanelOpen = props.open ?? uncontrolledIsPanelOpen;

  const activeEntry = useMemo(() => {
    return (
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null
    );
  }, [props.activeInstanceId, props.instanceEntries]);

  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  const selectedModel =
    selectedInstanceOptions.find((option) => option.slug === props.model) ??
    selectedInstanceOptions[0];
  const triggerTitle = selectedModel ? getTriggerDisplayModelName(selectedModel) : props.model;
  const triggerSubtitle = selectedModel?.subProvider;
  const triggerLabel = selectedModel ? getTriggerDisplayModelLabel(selectedModel) : props.model;
  const duplicateDriverCount = props.instanceEntries.filter(
    (entry) => activeEntry !== null && entry.driverKind === activeEntry.driverKind,
  ).length;
  const showInstanceBadge = Boolean(activeEntry?.accentColor) || duplicateDriverCount > 1;

  const setIsPanelOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsPanelOpen(open);
    }
  };

  useEffect(() => {
    setModelPickerOpen(isPanelOpen);
    return () => {
      setModelPickerOpen(false);
    };
  }, [isPanelOpen]);

  return (
    <Button
      size="sm"
      variant={props.triggerVariant ?? "ghost"}
      data-chat-provider-model-picker="true"
      data-state={isPanelOpen ? "open" : "closed"}
      aria-expanded={isPanelOpen}
      onClick={() => {
        if (props.disabled) return;
        setIsPanelOpen(!isPanelOpen);
      }}
      className={cn(
        "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
        props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56 sm:px-3",
        props.triggerClassName,
      )}
      disabled={props.disabled}
    >
      <span
        className={cn(
          "box-border flex w-full min-w-0 items-center gap-2 overflow-hidden",
          props.compact ? "max-w-36 sm:pl-1" : undefined,
        )}
      >
        {activeEntry ? (
          <ProviderInstanceIcon
            driverKind={activeEntry.driverKind}
            displayName={activeEntry.displayName}
            accentColor={activeEntry.accentColor}
            showBadge={showInstanceBadge}
            className={showInstanceBadge ? "size-5" : "size-4"}
            iconClassName={cn("size-4", props.activeProviderIconClassName)}
            badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 text-[7px]"
          />
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  "min-w-0 flex-1 overflow-hidden",
                  triggerSubtitle
                    ? "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1"
                    : "truncate",
                )}
              />
            }
          >
            {triggerSubtitle ? (
              <>
                <span className="min-w-0 truncate">{triggerSubtitle}</span>
                <span aria-hidden="true" className="shrink-0 opacity-60">
                  ·
                </span>
                <span className="min-w-0 truncate">{triggerTitle}</span>
              </>
            ) : (
              triggerTitle
            )}
          </TooltipTrigger>
          <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
        </Tooltip>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 opacity-60 transition-transform",
            isPanelOpen && "rotate-180",
          )}
        />
      </span>
    </Button>
  );
});
