import { useState } from "react";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { normalizeIntervalSeconds } from "./SettingsPanels.logic";

export function IntervalSecondsField({
  label,
  value,
  min,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  step: number;
  onCommit: (seconds: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(value);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }

  return (
    <NumberField
      value={draft}
      min={min}
      step={step}
      size="sm"
      className="w-32"
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        if (next === null) {
          setDraft(value);
          return;
        }
        const seconds = normalizeIntervalSeconds(next, min);
        setDraft(seconds);
        if (seconds !== value) onCommit(seconds);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${label}`} />
        <NumberFieldInput
          aria-label={`${label.charAt(0).toUpperCase()}${label.slice(1)} in seconds`}
        />
        <NumberFieldIncrement aria-label={`Increase ${label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}
