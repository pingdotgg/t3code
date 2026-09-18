import { MaterialRadioIndicator } from "../../components/MaterialRadioIndicator";
import {
  ModelRowContent,
  ChoiceRowContent,
  type ModelRowProps,
  type ChoiceRowProps,
} from "./ThreadSettingsRows.shared";

export function ModelRow(props: ModelRowProps) {
  return (
    <ModelRowContent
      {...props}
      labelNumberOfLines={2}
      minimumHeight={56}
      selectedClassName={props.selected ? "bg-thread-selected" : undefined}
      leadingSelection={<MaterialRadioIndicator selected={props.selected} />}
    />
  );
}

export function ChoiceRow(props: ChoiceRowProps) {
  return (
    <ChoiceRowContent
      {...props}
      minimumHeight={56}
      leadingSelection={<MaterialRadioIndicator selected={props.selected} />}
    />
  );
}
