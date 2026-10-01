import type { SourceControlProviderKind } from "@t3tools/contracts";

export const pullRequestHeadRef = (
  provider: SourceControlProviderKind | undefined,
  number: number,
) => (provider === "gitlab" ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`);
