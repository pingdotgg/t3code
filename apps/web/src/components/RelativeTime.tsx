import { useRelativeTimeLabel } from "../hooks/useRelativeTimeState";

// Use a live clock because the compiler caches inline formatting on the timestamp.
export function RelativeTime(props: { timestamp: string }) {
  return useRelativeTimeLabel(props.timestamp);
}
