export function pullRequestErrorHint(message: string): string | null {
  if (/rate.limit|too many requests|HTTP 429/i.test(message)) {
    return "The host has limited requests. Wait for the limit to reset, then retry.";
  }
  if (/unauthenticated|authentication|not logged|invalid.credential|HTTP 401/i.test(message)) {
    return "Sign in to the source control host on the selected server, then retry.";
  }
  if (/forbidden|permission|access denied|HTTP 403/i.test(message)) {
    return "Check that the signed-in account has access to this repository and action.";
  }
  if (/not found|HTTP 404/i.test(message)) {
    return "Check the PR link and repository access. The host can hide private PRs from accounts without access.";
  }
  if (/offline|disconnected|network|ECONN|ENOTFOUND|fetch failed|timed out/i.test(message)) {
    return "Check the selected server's connection, then retry. Your loaded PR data is kept.";
  }
  return null;
}
