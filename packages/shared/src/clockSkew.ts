// The relay permits proofs issued up to 60 seconds in its future.
const CLOCK_SKEW_LIMIT_SECONDS = 60;

/**
 * Seconds this machine's clock is ahead of (positive) or behind (negative) the
 * relay, judged from the HTTP `Date` header of a relay response received at
 * `nowMillis`, allowing for the request's monotonic elapsed time. `null` when
 * the header is missing, unparseable, or does not establish skew beyond the limit.
 */
export function clockSkewFromDateHeader(
  dateHeader: string | undefined,
  nowMillis: number,
  requestDurationMillis = 0,
): number | null {
  if (dateHeader === undefined) return null;
  const relayMillis = Date.parse(dateHeader);
  if (Number.isNaN(relayMillis)) return null;
  // `Date` has whole-second precision, so the relay's true time is up to a
  // second later than the header says.
  const skewSeconds = Math.round((nowMillis - relayMillis - 500) / 1_000);
  // Date may originate anywhere between request start and receipt. Transport
  // delay alone cannot establish that the host clock is ahead.
  const minimumSkewSeconds = Math.round(
    (nowMillis - relayMillis - 500 - requestDurationMillis) / 1_000,
  );
  return minimumSkewSeconds > CLOCK_SKEW_LIMIT_SECONDS
    ? minimumSkewSeconds
    : skewSeconds < -CLOCK_SKEW_LIMIT_SECONDS
      ? skewSeconds
      : null;
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
  return platform === "linux"
    ? "Turn on network time sync, for example with `timedatectl set-ntp true`."
    : "Turn on automatic date and time on the computer running T3 Code.";
}

export function describeClockSkew(seconds: number, platform: string): string {
  const direction = seconds > 0 ? "ahead" : "behind";
  return `The host computer's clock is ${skewAmount(seconds)} ${direction}, and T3 Connect needs it to be right. ${clockFixInstructions(platform)}`;
}
