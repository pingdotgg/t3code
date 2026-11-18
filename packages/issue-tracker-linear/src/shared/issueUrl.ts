import { IssueTrackerKind } from "@t3tools/contracts";
import type { IssueLink } from "@t3tools/source-control-core/shared/definition";

export const LINEAR_TRACKER = IssueTrackerKind.make("linear");
export const LINEAR_HOST = "linear.app";

/** `https://linear.app/<workspace>/issue/<TEAM>-<n>[/<slug>]`; the team key is the scope. */
export function parseLinearIssueUrl(url: URL): (IssueLink & { readonly workspace: string }) | null {
  if (url.protocol !== "https:" || url.host.toLowerCase() !== LINEAR_HOST) return null;
  const [, workspace, resource, key] = url.pathname.split("/");
  if (!workspace || resource !== "issue" || key === undefined) return null;
  const scope = /^([A-Z][A-Z0-9_]*)-[1-9][0-9]*$/.exec(key)?.[1];
  return scope === undefined ? null : { host: LINEAR_HOST, workspace, scope, key };
}
