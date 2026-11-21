import { RadioIndicator } from "../../components/ui/RadioIndicator";
import {
  ModelRowContent,
  ChoiceRowContent,
  type ModelRowProps,
  type ChoiceRowProps,
} from "./ThreadSettingsRows.shared";
import { defineNativePluginFeature } from "../../plugins/features";
export const ModelRow = defineNativePluginFeature(
  "native.features.threads.thread-settings-rows.model-row",
  BuiltinModelRow,
);
export const ChoiceRow = defineNativePluginFeature(
  "native.features.threads.thread-settings-rows.choice-row",
  BuiltinChoiceRow,
);

function BuiltinModelRow(props: ModelRowProps) {
  return (
    <ModelRowContent
      {...props}
      labelNumberOfLines={2}
      minimumHeight={56}
      selectedClassName={props.selected ? "bg-secondary" : undefined}
      leadingSelection={<RadioIndicator selected={props.selected} />}
    />
  );
}

function BuiltinChoiceRow(props: ChoiceRowProps) {
  return (
    <ChoiceRowContent
      {...props}
      minimumHeight={56}
      leadingSelection={<RadioIndicator selected={props.selected} />}
    />
  );
}
