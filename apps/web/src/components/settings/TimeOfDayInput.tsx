import type { TimestampFormat } from "@t3tools/contracts/settings";

import { resolveHour12 } from "../../timestampFormat";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

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
}: {
  id?: string;
  label: string;
  value: string;
  timestampFormat: TimestampFormat;
  onChange: (value: string) => void;
}) {
  const hour12 = resolveHour12(timestampFormat);
  const separator = value.indexOf(":");
  const hour = Number(value.slice(0, separator));
  const minute = value.slice(separator + 1);
  const period = hour < 12 ? "AM" : "PM";

  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      <TimePart
        id={id}
        label={`${label} hours`}
        value={pad(hour12 ? hour % 12 || 12 : hour)}
        options={hour12 ? HOURS_12 : HOURS_24}
        onChange={(next) => {
          const nextHour = hour12 ? (Number(next) % 12) + (hour >= 12 ? 12 : 0) : Number(next);
          onChange(`${pad(nextHour)}:${minute}`);
        }}
      />
      <span aria-hidden="true">:</span>
      <TimePart
        label={`${label} minutes`}
        value={minute}
        options={MINUTES}
        onChange={(next) => onChange(`${pad(hour)}:${next}`)}
      />
      {hour12 ? (
        <TimePart
          label={`${label} period`}
          value={period}
          options={PERIODS}
          onChange={(next) => onChange(`${pad((hour % 12) + (next === "PM" ? 12 : 0))}:${minute}`)}
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
      <SelectTrigger id={id} size="sm" className="w-auto min-w-0" aria-label={label}>
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
