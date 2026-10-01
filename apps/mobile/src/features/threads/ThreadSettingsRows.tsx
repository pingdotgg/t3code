import { SymbolView } from "../../components/AppSymbol";
import {
  ModelRowContent,
  ChoiceRowContent,
  type ModelRowProps,
  type ChoiceRowProps,
} from "./ThreadSettingsRows.shared";

function SelectedCheckmark(props: { readonly selected: boolean }) {
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

export function ModelRow(props: ModelRowProps) {
  return (
    <ModelRowContent
      {...props}
      labelNumberOfLines={1}
      trailingSelection={<SelectedCheckmark selected={props.selected} />}
    />
  );
}

export function ChoiceRow(props: ChoiceRowProps) {
  return (
    <ChoiceRowContent
      {...props}
      trailingSelection={<SelectedCheckmark selected={props.selected} />}
    />
  );
}
