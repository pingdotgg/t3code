import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";

export function SidebarCompletedTime({ completedAt }: { completedAt: string }) {
  // Subscribe inside the label so time advances even when the row is memoized.
  const nowMinute = useNowMinute();
  const relativeTime = formatRelativeTimeLabel(completedAt, Date.parse(`${nowMinute}:00Z`));
  const label = relativeTime === "just now" ? "now" : relativeTime.replace(/ ago$/, "");

  return (
    <time dateTime={completedAt} className="inline-flex items-center">
      <span className="sr-only">Completed </span>
      <span className="text-secondary-label">{label}</span>
    </time>
  );
}
