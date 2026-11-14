import type { TimestampFormat } from "@t3tools/contracts/settings";

import { resolveHour12 } from "../../timestampFormat";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { readTimeOfDay, writeTimeOfDay } from "./TimeOfDayInput.logic";

const pad = (value: number) => String(value).padStart(2, "0");
const HOURS_24 = Array.from({ length: 24 }, (_, hour) => pad(hour));
const HOURS_12 = Array.from({ length: 12 }, (_, hour) => pad(hour + 1));
const MINUTES = Array.from({ length: 60 }, (_, minute) => pad(minute));
const PERIODS = ["AM", "PM"];

export function TimeOfDayInput({
  id,
  label,
  value,
  timestampFormat,
  onChange,
  "aria-describedby": describedBy,
}: {
  id?: string;
  label: string;
  "aria-describedby"?: string | undefined;
  value: string;
  timestampFormat: TimestampFormat;
  onChange: (value: string) => void;
}) {
  const hour12 = resolveHour12(timestampFormat);
  const parts = readTimeOfDay(value, hour12);

  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      className="flex items-center gap-1"
    >
      <TimePart
        id={id}
        label={`${label} hours`}
        value={parts.hour}
        options={hour12 ? HOURS_12 : HOURS_24}
        onChange={(next) => onChange(writeTimeOfDay(value, "hour", next, hour12))}
      />
      <span aria-hidden="true">:</span>
      <TimePart
        label={`${label} minutes`}
        value={parts.minute}
        options={MINUTES}
        onChange={(next) => onChange(writeTimeOfDay(value, "minute", next, hour12))}
      />
      {hour12 ? (
        <TimePart
          label={`${label} period`}
          value={parts.period}
          options={PERIODS}
          onChange={(next) => onChange(writeTimeOfDay(value, "period", next, hour12))}
        />
      ) : null}
    </div>
  );
}

function TimePart({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id?: string | undefined;
  label: string;
  value: string;
  options: ReadonlyArray<string>;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => next !== null && onChange(next)}>
      <SelectTrigger id={id} size="sm" variant="inline" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
