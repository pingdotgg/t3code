import { useRelativeTimeState } from "../hooks/useRelativeTimeState";

// A "5m ago" label that keeps counting. Formatting the label inline in render
// does not: the React Compiler caches it on the timestamp alone.
export function RelativeTime(props: { timestamp: string }) {
  const relative = useRelativeTimeState(props.timestamp);
  if (relative.status !== "relative") return null;
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}
