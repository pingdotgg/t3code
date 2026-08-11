export type AndroidSnoozePicker = "date" | "time";

export function mergeAndroidPickerValue(
  current: Date,
  selected: Date,
  part: AndroidSnoozePicker,
): Date {
  if (part === "date") {
    // Material DatePicker returns the chosen calendar day as UTC midnight.
    return new Date(
      selected.getUTCFullYear(),
      selected.getUTCMonth(),
      selected.getUTCDate(),
      current.getHours(),
      current.getMinutes(),
    );
  }

  return new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate(),
    selected.getHours(),
    selected.getMinutes(),
  );
}
