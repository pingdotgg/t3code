export function threadWorkLogOverflowNoun(
  onlyToolRows: boolean,
  count: number,
): "tool call" | "tool calls" | "log entry" | "log entries" {
  if (onlyToolRows) {
    return count === 1 ? "tool call" : "tool calls";
  }
  return count === 1 ? "log entry" : "log entries";
}
