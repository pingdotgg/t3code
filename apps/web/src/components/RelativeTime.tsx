import { useRelativeTimeState } from "../hooks/useRelativeTimeState";

// Use a live clock because the compiler caches inline formatting on the timestamp.
export function RelativeTime(props: { timestamp: string }) {
  const relative = useRelativeTimeState(props.timestamp);
  if (relative.status !== "relative") return null;
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}
