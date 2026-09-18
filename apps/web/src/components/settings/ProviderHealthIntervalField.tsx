import * as Duration from "effect/Duration";
import { useState } from "react";

import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import {
  normalizeProviderHealthIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
} from "./SettingsPanels.logic";

interface ProviderHealthIntervalFieldProps {
  readonly valueSeconds: number;
  /** Field name for the accessible labels, e.g. "Provider health interval". */
  readonly label: string;
  readonly onCommit: (interval: Duration.Duration) => void;
}

/**
 * Keeps typing local and normalizes on commit (blur, Enter, or a stepper
 * click), so a partially typed value below the minimum is never persisted as
 * "disabled" mid-edit.
 */
export function ProviderHealthIntervalField({
  valueSeconds,
  label,
  onCommit,
}: ProviderHealthIntervalFieldProps) {
  const [draft, setDraft] = useState<number | null>(valueSeconds);
  const [savedSeconds, setSavedSeconds] = useState(valueSeconds);
  if (savedSeconds !== valueSeconds) {
    setSavedSeconds(valueSeconds);
    setDraft(valueSeconds);
  }
  const stepperLabel = label.charAt(0).toLowerCase() + label.slice(1);

  return (
    <NumberField
      value={draft}
      min={0}
      step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
      size="sm"
      className="w-32"
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        const seconds = normalizeProviderHealthIntervalSeconds(next, valueSeconds);
        setDraft(seconds);
        if (seconds !== valueSeconds) onCommit(Duration.seconds(seconds));
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${stepperLabel}`} />
        <NumberFieldInput aria-label={`${label} in seconds`} />
        <NumberFieldIncrement aria-label={`Increase ${stepperLabel}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}
