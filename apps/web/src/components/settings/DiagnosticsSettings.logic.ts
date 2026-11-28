import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";

export function formatDiagnosticsDuration(value: number): string {
  const milliseconds = Math.round(value);
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.0+$/, "")} s`;
}

export function formatProcessName(command: string): string {
  const firstToken = command.trim().split(/\s+/)[0];
  if (!firstToken) return command;
  const normalized = firstToken.replace(/^['"]|['"]$/g, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? normalized;
}

export function formatShortProcessName(command: string): string {
  const name = formatProcessName(command);
  if (name.length <= 42) return name;
  // Never end on the first half of an emoji.
  return `${name.slice(0, splitsSurrogatePair(name, 39) ? 38 : 39)}...`;
}
