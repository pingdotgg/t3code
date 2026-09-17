import { useState } from "react";
import {
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts";

import { AppTextInput } from "../../../components/AppText";

export interface AutoSettleDaysFieldProps {
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly disabled?: boolean;
}

export function AutoSettleDaysField(props: AutoSettleDaysFieldProps) {
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
      parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
      parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
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
      accessibilityLabel="Days before auto-settle"
      editable={!props.disabled}
    />
  );
}
