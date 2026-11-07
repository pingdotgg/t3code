export function pullRequestTabOffset(
  current: number,
  saved: number | undefined,
  headerEnd: number,
) {
  return current < headerEnd ? current : Math.max(headerEnd, saved ?? headerEnd);
}
