/** Parse macOS pmset battery output into a 0–100 charge percent, or null when none is present. */
export const parsePmsetBatt = (output: string): number | null => {
  if (/no batter(?:y|ies)/i.test(output)) return null;
  const match =
    /InternalBattery[^\n]*?\b(\d{1,3})\s*%/i.exec(output) ??
    /\b(\d{1,3})\s*%;\s*(?:charged|charging|discharging|not charging)/i.exec(output);
  if (!match) return null;
  const percent = Number(match[1]);
  return Number.isInteger(percent) && percent >= 0 && percent <= 100 ? percent : null;
};

/** Parse a Linux sysfs battery capacity file. */
export const parseLinuxBatteryCapacity = (output: string): number | null => {
  const trimmed = output.trim();
  if (trimmed.length === 0) return null;
  const percent = Number(trimmed);
  return Number.isInteger(percent) && percent >= 0 && percent <= 100 ? percent : null;
};

/** Whether macOS pmset says the machine is drawing from battery. */
export const parsePmsetOnBattery = (output: string): boolean | null => {
  if (/Now drawing from 'Battery Power'/i.test(output)) return true;
  if (/Now drawing from 'AC Power'/i.test(output)) return false;
  return null;
};

/**
 * Whether Linux is on battery given each Mains supply's sysfs `online` value.
 * Plugged in if any supply is online; on battery only when every known supply is offline.
 */
export const parseLinuxMainsOnlineStates = (
  onlineValues: ReadonlyArray<string>,
): boolean | null => {
  let foundMains = false;
  for (const online of onlineValues) {
    foundMains = true;
    if (online === "1") return false;
    if (online !== "0") return null;
  }
  return foundMains ? true : null;
};
