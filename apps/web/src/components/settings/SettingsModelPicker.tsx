import type {
  ProviderDriverKind,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { resolveTraitsTriggerLabel, TraitsPicker } from "../chat/TraitsPicker";
import { cn } from "../../lib/utils";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";

type ProviderModelPickerProps = ComponentProps<typeof ProviderModelPicker>;
type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

/**
 * Full width while the settings row stacks its control under the text, like the
 * other settings selects; content width once the row goes side by side.
 */
const MODEL_TRIGGER_CLASSNAME = cn(
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  "w-full @min-[26rem]/settings-row:w-auto",
);

/**
 * One "Model · Effort" select for settings rows. The model list opens from
 * the trigger, and the selected model's traits (effort, fast mode, context
 * window) sit under the list, since the options depend on the model.
 */
export function SettingsModelPicker({
  traits,
  ...pickerProps
}: Omit<ProviderModelPickerProps, "triggerVariant" | "triggerClassName" | "lockedProvider"> & {
  /** Omit for a mixed selection, where no single model's traits apply. */
  traits: {
    provider: ProviderDriverKind;
    models: ReadonlyArray<ServerProviderModel>;
    modelOptions: ProviderOptions | null | undefined;
    planModeEnabled: boolean;
    onModelOptionsChange: (options: ProviderOptions | undefined) => void;
  } | null;
}) {
  const traitsLabel = traits
    ? resolveTraitsTriggerLabel({
        provider: traits.provider,
        models: traits.models,
        model: pickerProps.model,
        modelOptions: traits.modelOptions,
        planModeEnabled: traits.planModeEnabled,
      })
    : null;
  return (
    <ProviderModelPicker
      {...pickerProps}
      lockedProvider={null}
      triggerVariant="settings"
      triggerClassName={MODEL_TRIGGER_CLASSNAME}
      triggerDetail={traitsLabel}
      popupAlign="end"
      popupFooter={
        traits && traitsLabel ? (
          <div className="flex items-center justify-between gap-3 border-t border-divider px-3 py-2">
            <span className="text-meta text-muted-foreground">Options</span>
            <TraitsPicker
              provider={traits.provider}
              models={traits.models}
              model={pickerProps.model}
              modelOptions={traits.modelOptions ?? []}
              allowPromptInjectedEffort={false}
              planModeEnabled={traits.planModeEnabled}
              triggerVariant="settings"
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onModelOptionsChange={traits.onModelOptionsChange}
            />
          </div>
        ) : undefined
      }
    />
  );
}
