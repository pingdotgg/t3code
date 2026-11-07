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
