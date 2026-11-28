import { IssueTrackerKind } from "@t3tools/contracts";
import type { StandaloneIssueLinkDefinition } from "@t3tools/source-control-core/shared/definition";

export const LINEAR_KIND = IssueTrackerKind.make("linear");
export const LINEAR_HOST = "linear.app";

/** `https://linear.app/<workspace>/issue/<TEAM>-<n>[/<slug>]`, keeping the workspace. */
export function parseLinearIssueUrl(url: URL) {
  if (url.protocol !== "https:" || url.host.toLowerCase() !== LINEAR_HOST) return null;
  const [, workspace, resource, key] = url.pathname.split("/");
  if (!workspace || resource !== "issue" || key === undefined) return null;
  const scope = /^([A-Z][A-Z0-9_]*)-[1-9][0-9]*$/.exec(key)?.[1];
  return scope === undefined ? null : { host: LINEAR_HOST, workspace, scope, key };
}

export const issueLinkDefinition: StandaloneIssueLinkDefinition = {
  tracker: LINEAR_KIND,
  parseIssueUrl: parseLinearIssueUrl,
  mayContainIssueUrl: (text: string) => /linear\.app(?::\d+)?\//i.test(text),
};
