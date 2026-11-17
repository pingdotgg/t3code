import { useState } from "react";
import { useClientSettings } from "../hooks/useSettings";
import { resolveHour12 } from "../timestampFormat";
import { Input, type InputProps } from "./ui/input";
import { formatTimeOfDay, parseTimeOfDay } from "./TimeInput.logic";

// <input type="time"> picks 12/24-hour from the browser locale, which the Time format setting cannot change.
const browserHour12 = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions()
  .hour12;

type TimeInputProps = Omit<InputProps, "type" | "value" | "onChange" | "nativeInput"> & {
  readonly value: string;
  /** `HH:MM`, or `null` while the typed text is not a time. */
  readonly onChange: (value: string | null) => void;
};

/** An `HH:MM` field shown in the user's Time format. */
export function TimeInput({ value, onChange, ...props }: TimeInputProps) {
  const hour12 = useClientSettings((settings) => resolveHour12(settings.timestampFormat));
  const [draft, setDraft] = useState<string | null>(null);

  if (hour12 === (browserHour12 ?? false)) {
    return (
      <Input
        {...props}
        nativeInput
        type="time"
        value={value}
        onChange={(event) => onChange(event.target.value || null)}
      />
    );
  }

  return (
    <Input
      {...props}
      nativeInput
      type="text"
      autoComplete="off"
      placeholder={hour12 ? "h:mm AM" : "HH:MM"}
      aria-invalid={draft !== null && parseTimeOfDay(draft) === null ? true : undefined}
      value={draft ?? formatTimeOfDay(value, hour12)}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(parseTimeOfDay(event.target.value));
      }}
      onBlur={(event) => {
        if (parseTimeOfDay(event.target.value) !== null) setDraft(null);
        props.onBlur?.(event);
      }}
    />
  );
}
