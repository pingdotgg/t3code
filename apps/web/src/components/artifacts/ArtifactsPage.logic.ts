import type { ClaudeArtifactAccount } from "@t3tools/contracts";

/** Each account keeps its own claude.ai login in a browser profile of its own. */
export function artifactBrowserProfileId(instanceId: string): string {
  return `claude-artifacts-${instanceId}`;
}

/** Accounts the filter shows, each with the artifacts whose title matches the search. */
export function filterArtifactAccounts(
  accounts: ReadonlyArray<ClaudeArtifactAccount>,
  query: string,
  instanceId: string | null,
): ReadonlyArray<ClaudeArtifactAccount> {
  const needle = query.trim().toLocaleLowerCase();
  return accounts
    .filter((account) => instanceId === null || account.instanceId === instanceId)
    .map((account) =>
      needle.length === 0
        ? account
        : {
            ...account,
            artifacts: account.artifacts.filter((artifact) =>
              artifact.title.toLocaleLowerCase().includes(needle),
            ),
          },
    );
}
