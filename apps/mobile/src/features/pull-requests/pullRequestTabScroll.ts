export function pullRequestTabOffset(
  current: number,
  saved: number | undefined,
  headerEnd: number,
) {
  return current < headerEnd - 0.5 ? current : Math.max(headerEnd, saved ?? headerEnd);
}
