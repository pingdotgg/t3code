import { IssueTrackerKind } from "@t3tools/contracts";

export const LINEAR_KIND = IssueTrackerKind.make("linear");
export const LINEAR_HOST = "linear.app";

/** `https://linear.app/<workspace>/issue/<TEAM>-<n>[/<slug>]`, keeping the workspace. */
export function parseLinearIssueUrl(url: URL) {
  if (url.protocol !== "https:" || url.host.toLowerCase() !== LINEAR_HOST) return null;
  const [, workspace, resource, key] = url.pathname.split("/");
  if (!workspace || resource !== "issue" || key === undefined) return null;
  const scope = /^([A-Z0-9][A-Z0-9_]*)-[1-9][0-9]*$/.exec(key)?.[1];
  return scope === undefined ? null : { host: LINEAR_HOST, workspace, scope, key };
}
