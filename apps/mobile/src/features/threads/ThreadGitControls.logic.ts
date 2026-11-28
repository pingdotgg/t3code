import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailStart = value.length - Math.floor((maxLength - 1) / 2);
  const headEnd = splitsSurrogatePair(value, headLength) ? headLength - 1 : headLength;
  const tailFrom = splitsSurrogatePair(value, tailStart) ? tailStart + 1 : tailStart;
  return `${value.slice(0, headEnd)}…${value.slice(tailFrom)}`;
}

export function compactMenuBranchLabel(branch: string): string {
  return truncateMiddle(branch, 24);
}
