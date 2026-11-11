// Offset pagination can return the same token on two pages when the list
// shifts between fetches; keep the first occurrence of each id.
export const uniqueTokens = <T extends { id?: string | null }>(tokens: ReadonlyArray<T>): T[] => {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    if (!token.id) return true;
    if (seen.has(token.id)) return false;
    seen.add(token.id);
    return true;
  });
};
