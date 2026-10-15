/**
 * T3 Connect's signed requests only work while the host clock is close to the
 * relay's. These helpers decide when it is too far off and tell the user how
 * to fix it, so the server, CLI and settings all say the same thing.
 */

// The relay accepts proofs issued up to 60 seconds in its future. Past that, a
// skewed clock is enough on its own to explain a rejection.
const CLOCK_SKEW_LIMIT_SECONDS = 60;

/**
 * Seconds this machine's clock is ahead of (positive) or behind (negative) the
 * relay, judged from the HTTP `Date` header of a relay response received at
 * `nowMillis`. `null` when the header is missing, unparseable, or within the
 * limit.
 */
export function clockSkewFromDateHeader(
  dateHeader: string | undefined,
  nowMillis: number,
): number | null {
  if (dateHeader === undefined) return null;
  const relayMillis = Date.parse(dateHeader);
  if (Number.isNaN(relayMillis)) return null;
  // `Date` has whole-second precision, so the relay's true time is up to a
  // second later than the header says.
  const skewSeconds = Math.round((nowMillis - relayMillis - 500) / 1_000);
  return Math.abs(skewSeconds) > CLOCK_SKEW_LIMIT_SECONDS ? skewSeconds : null;
}

function skewAmount(seconds: number): string {
  const magnitude = Math.abs(seconds);
  const minutes = Math.round(magnitude / 60);
  const hours = Math.round(magnitude / (60 * 60));
  const [value, unit] =
    magnitude < 90
      ? [magnitude, "second"]
      : minutes < 60
        ? [minutes, "minute"]
        : hours < 36
          ? [hours, "hour"]
          : [Math.round(magnitude / (24 * 60 * 60)), "day"];
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

function clockFixInstructions(platform: string): string {
  if (platform === "win32") {
    return 'Open Settings > Time & language > Date & time, turn on "Set time automatically", then press "Sync now".';
  }
  if (platform === "darwin") {
    return 'Open System Settings > General > Date & Time and turn on "Set time and date automatically".';
  }
  return "Turn on network time sync, for example with `timedatectl set-ntp true`.";
}

/**
 * What to tell the user when T3 Connect fails because of `seconds` of skew.
 * `platform` is the host's `process.platform`, since that is the clock to fix.
 */
export function describeClockSkew(seconds: number, platform: string): string {
  const direction = seconds > 0 ? "ahead" : "behind";
  return `This computer's clock is ${skewAmount(seconds)} ${direction}, and T3 Connect needs it to be right. ${clockFixInstructions(platform)} T3 Connect reconnects by itself once the clock is correct.`;
}
