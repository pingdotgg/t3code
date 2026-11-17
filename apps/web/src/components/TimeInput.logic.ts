const TIME_OF_DAY = /^(\d{2}):(\d{2})$/;
const TYPED_TIME = /^(\d{1,2}):?(\d{2})\s*(?:([ap])\.?\s*(?:m\.?)?)?$/i;

/** Shows an `HH:MM` value as `17:30` or `5:30 PM`; anything else passes through. */
export function formatTimeOfDay(value: string, hour12: boolean): string {
  const match = TIME_OF_DAY.exec(value);
  if (!match || !hour12) return value;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

/** Reads `17:30`, `1730`, `5:30 PM` or `5:30pm` back as `HH:MM`, or `null` when it is not a time. */
export function parseTimeOfDay(text: string): string | null {
  const match = TYPED_TIME.exec(text.trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
