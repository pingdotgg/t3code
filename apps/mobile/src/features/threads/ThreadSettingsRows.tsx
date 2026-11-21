import { SymbolView } from "../../components/ui/AppSymbol";
import {
  ModelRowContent,
  ChoiceRowContent,
  type ModelRowProps,
  type ChoiceRowProps,
} from "./ThreadSettingsRows.shared";
import { defineNativePluginFeature } from "../../plugins/features";
const SelectedCheckmark = defineNativePluginFeature(
  "native.features.threads.thread-settings-rows.selected-checkmark",
  BuiltinSelectedCheckmark,
);

export const ModelRow = defineNativePluginFeature(
  "native.features.threads.thread-settings-rows.model-row",
  BuiltinModelRow,
);
export const ChoiceRow = defineNativePluginFeature(
  "native.features.threads.thread-settings-rows.choice-row",
  BuiltinChoiceRow,
);

function BuiltinSelectedCheckmark(props: { readonly selected: boolean }) {
  return props.selected ? (
    <SymbolView
      name="checkmark"
      size={16}
      tintColorClassName="accent-icon"
      type="monochrome"
      weight="semibold"
    />
  ) : null;
}

function BuiltinModelRow(props: ModelRowProps) {
  return (
    <ModelRowContent
      {...props}
      labelNumberOfLines={1}
      trailingSelection={<SelectedCheckmark selected={props.selected} />}
    />
  );
}

function BuiltinChoiceRow(props: ChoiceRowProps) {
  return (
    <ChoiceRowContent
      {...props}
      trailingSelection={<SelectedCheckmark selected={props.selected} />}
    />
  );
}
