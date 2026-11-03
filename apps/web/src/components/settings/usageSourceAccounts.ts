export function withAccountVisibility(
  hiddenAccounts: ReadonlyArray<string>,
  accountId: string,
  visible: boolean,
): ReadonlyArray<string> {
  if (visible) return hiddenAccounts.filter((id) => id !== accountId);
  return hiddenAccounts.includes(accountId) ? hiddenAccounts : [...hiddenAccounts, accountId];
}
