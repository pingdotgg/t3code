import {
  type ModelSelection,
  type OrchestrationV2FallbackSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { ShieldAlertIcon } from "lucide-react";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ComposerControl,
  ComposerControlChevron,
  type ComposerControlSize,
} from "./ComposerControl";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";
import { cn } from "~/lib/utils";

export interface FallbackModelPickerProps {
  fallbackSelection?: OrchestrationV2FallbackSelection | null | undefined;
  activeInstanceId: ProviderInstanceId;
  activeModel: string;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  size?: ComposerControlSize;
  disabled?: boolean;
  className?: string;
  onFallbackSelect: (selection: OrchestrationV2FallbackSelection | null) => void;
}

export const FallbackModelPicker = memo(function FallbackModelPicker(
  props: FallbackModelPickerProps,
) {
  const {
    fallbackSelection,
    instanceEntries,
    modelOptionsByInstance,
    size = "sm",
    disabled = false,
    className,
    onFallbackSelect,
  } = props;

  const currentValue = useMemo(() => {
    if (!fallbackSelection) return "off";
    if (fallbackSelection.mode === "auto") return "auto";
    return `specific:${fallbackSelection.modelSelection.instanceId}:${fallbackSelection.modelSelection.model}`;
  }, [fallbackSelection]);

  const displayLabel = useMemo(() => {
    if (!fallbackSelection) return "Fallback: Off";
    if (fallbackSelection.mode === "auto") return "Fallback: Auto";
    const { instanceId, model } = fallbackSelection.modelSelection;
    const options = modelOptionsByInstance.get(instanceId) ?? [];
    const found = options.find((opt) => opt.slug === model);
    const modelName = found ? found.name : model;
    return `Fallback: ${modelName}`;
  }, [fallbackSelection, modelOptionsByInstance]);

  const handleValueChange = (val: string) => {
    if (val === "off") {
      onFallbackSelect(null);
    } else if (val === "auto") {
      onFallbackSelect({ mode: "auto" });
    } else if (val.startsWith("specific:")) {
      const parts = val.slice("specific:".length).split(":");
      const instanceId = parts[0] as ProviderInstanceId;
      const model = parts.slice(1).join(":");
      onFallbackSelect({
        mode: "specific",
        modelSelection: { instanceId, model },
      });
    }
  };

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  size={size}
                  disabled={disabled}
                  className={cn(
                    "min-w-fit max-w-44 select-none gap-1 px-2 text-xs",
                    fallbackSelection ? "text-warning hover:text-warning/90 font-medium" : "",
                    className,
                  )}
                  data-fallback-picker="true"
                />
              }
            >
              <ShieldAlertIcon
                className={cn(
                  "size-3.5 shrink-0",
                  fallbackSelection ? "text-warning" : "text-muted-foreground",
                )}
              />
              <span className="truncate">{displayLabel}</span>
              <ComposerControlChevron />
            </MenuTrigger>
          }
        />
        <TooltipPopup side="top" className="text-xs">
          Configure fallback AI agent when rate or usage limits occur
        </TooltipPopup>
      </Tooltip>

      <MenuPopup className="w-64 max-h-[24rem] overflow-y-auto p-1 text-xs">
        <MenuGroup>
          <div className="px-2 pt-1 font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">
            Rate Limit Fallback
          </div>
          <div className="px-2 pb-1.5 text-[11px] text-muted-foreground">
            Action when active AI agent hits usage or rate limits.
          </div>
          <MenuRadioGroup value={currentValue} onValueChange={handleValueChange}>
            <MenuRadioItem value="off" closeOnClick>
              <span className="flex flex-col">
                <span className="font-medium">Off</span>
                <span className="text-[11px] text-muted-foreground">
                  Pause and wait for limits to reset
                </span>
              </span>
            </MenuRadioItem>
            <MenuRadioItem value="auto" closeOnClick>
              <span className="flex flex-col">
                <span className="font-medium text-warning">Auto Fallback</span>
                <span className="text-[11px] text-muted-foreground">
                  Seamlessly hand off to another available provider
                </span>
              </span>
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>

        {instanceEntries.map((entry) => {
          const models = modelOptionsByInstance.get(entry.instanceId) ?? [];
          if (models.length === 0) return null;

          return (
            <div key={entry.instanceId}>
              <MenuDivider />
              <MenuGroup>
                <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 font-medium text-[11px] text-muted-foreground">
                  <ProviderInstanceIcon
                    driverKind={entry.driverKind}
                    displayName={entry.displayName}
                    accentColor={entry.accentColor}
                    className="size-3.5"
                  />
                  <span>{entry.displayName}</span>
                </div>
                <MenuRadioGroup value={currentValue} onValueChange={handleValueChange}>
                  {models.map((m) => {
                    const itemVal = `specific:${entry.instanceId}:${m.slug}`;
                    return (
                      <MenuRadioItem key={m.slug} value={itemVal} closeOnClick>
                        <span className="truncate">{m.name}</span>
                      </MenuRadioItem>
                    );
                  })}
                </MenuRadioGroup>
              </MenuGroup>
            </div>
          );
        })}
      </MenuPopup>
    </Menu>
  );
});
