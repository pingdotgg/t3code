import { ansiFg, theme } from "./CliKit/index.ts";

/** `450ms` under a second, `1.2s` at or above — shared by every renderer. */
export const formatElapsed = (ms: number): string =>
  ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`;

export const TAIL_COLORS = [
  ansiFg(theme.color.accent),
  ansiFg(theme.color.info),
  ansiFg(theme.color.danger),
  ansiFg(theme.color.warning),
  ansiFg(theme.color.accentBright),
  ansiFg(theme.color.muted),
  ansiFg(theme.color.accentMuted),
  ansiFg(theme.color.success),
];

export const formatLocalTimestamp = (date: Date): string => {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  const tz =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms} ${tz}`;
};
