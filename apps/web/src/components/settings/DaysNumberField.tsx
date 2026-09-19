import { useState } from "react";

import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";

/** Keep incomplete input local; commit a whole day count when editing finishes. */
export function DaysNumberField({
  value,
  min,
  max,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onCommit: (days: number) => void;
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
      max={max}
      step={1}
      size="sm"
      className="w-auto"
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        if (next === null) setDraft(value);
        else {
          const days = Math.min(max, Math.max(min, Math.round(next)));
          setDraft(days);
          onCommit(days);
        }
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${label}`} />
        <NumberFieldInput
          aria-label={label}
          size={new Intl.NumberFormat().format(draft ?? value).length}
          className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right in-data-[size=sm]:px-1"
        />
        <span aria-hidden="true" className="self-center pr-2 text-xs">
          days
        </span>
        <NumberFieldIncrement aria-label={`Increase ${label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}
