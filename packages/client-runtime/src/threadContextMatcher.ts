/**
 * Small pure matcher for @thread-name candidate ranking. Kept in
 * client-runtime so web and (future) mobile pickers share the same
 * case-insensitive substring rule without importing web state.
 */
export function matchThreadContextTitle(title: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return false;
  return title.toLowerCase().includes(needle);
}
