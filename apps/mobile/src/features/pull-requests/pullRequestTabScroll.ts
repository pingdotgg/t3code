/** Preserve the shared header's position, then each tab's own reading position. */
export function pullRequestTabOffset(
  current: number,
  saved: number | undefined,
  headerEnd: number,
) {
  return current < headerEnd ? current : Math.max(headerEnd, saved ?? headerEnd);
}
