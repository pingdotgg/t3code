import { useState } from "react";
import { AppTextInput } from "./AppText";

export interface NumberFieldProps {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly formatValue?: (value: number) => string;
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly disabled?: boolean;
}

export function NumberField(props: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (props.disabled) {
      setDraft(null);
      return;
    }
    const text = (draft ?? "").trim();
    setDraft(null);
    // Validate the whole input; decimals and trailing text must not become whole days.
    const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (
      Number.isInteger(parsed) &&
      parsed >= props.min &&
      parsed <= props.max &&
      parsed !== props.value
    ) {
      props.onValueChange(parsed);
    }
  };
  return (
    <AppTextInput
      className="min-h-10 w-20 rounded-xl px-3 py-2 text-center text-base"
      keyboardType="number-pad"
      returnKeyType="done"
      value={draft ?? String(props.value)}
      onChangeText={setDraft}
      onBlur={commit}
      onSubmitEditing={commit}
      accessibilityLabel={props.label}
      editable={!props.disabled}
    />
  );
}
