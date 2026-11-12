export type TimeOfDayPart = "hour" | "minute" | "period";

const pad = (value: number) => String(value).padStart(2, "0");

function parse(value: string) {
  const [hourText = "0", minute = "00"] = value.split(":");
  return { hour: Number(hourText), minute };
}

export function readTimeOfDay(value: string, hour12: boolean) {
  const { hour, minute } = parse(value);
  return {
    hour: pad(hour12 ? hour % 12 || 12 : hour),
    minute,
    period: hour < 12 ? "AM" : "PM",
  };
}

/** Applies one selector's value and returns the canonical 24-hour `HH:MM`. */
export function writeTimeOfDay(
  value: string,
  part: TimeOfDayPart,
  next: string,
  hour12: boolean,
): string {
  const { hour, minute } = parse(value);
  switch (part) {
    case "hour":
      return `${pad(hour12 ? (Number(next) % 12) + (hour >= 12 ? 12 : 0) : Number(next))}:${minute}`;
    case "minute":
      return `${pad(hour)}:${next}`;
    case "period":
      return `${pad((hour % 12) + (next === "PM" ? 12 : 0))}:${minute}`;
  }
}
