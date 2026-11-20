import { parseDays } from "../settingsModel";
import { fieldClass } from "./fieldClass";

export function DaysInput({
  label,
  value,
  minimum,
  disabled,
  onCommit,
}: {
  label: string;
  value: number | null;
  minimum: number;
  disabled?: boolean;
  onCommit: (value: number | null) => void;
}) {
  const shown = value === null ? "" : String(value);
  return (
    <span className="flex items-center gap-1.5 text-muted">
      <input
        key={shown}
        aria-label={label}
        defaultValue={shown}
        placeholder="Off"
        disabled={disabled}
        inputMode="numeric"
        onBlur={(event) => {
          const days = parseDays(event.target.value, minimum);
          if (days === "invalid") event.target.value = shown;
          else if (days !== value) onCommit(days);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className={`${fieldClass} w-16 text-right`}
      />
      days
    </span>
  );
}
