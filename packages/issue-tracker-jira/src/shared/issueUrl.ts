import { IssueTrackerKind } from "@t3tools/contracts";

export const JIRA_KIND = IssueTrackerKind.make("jira");
export const JIRA_HOST = "atlassian.net";

/** `https://<site>.atlassian.net/browse/<PROJECT>-<n>`, keeping the site as the workspace. */
export function parseJiraIssueUrl(url: URL) {
  const site = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !site.endsWith(`.${JIRA_HOST}`)) return null;
  const [, resource, key] = url.pathname.split("/");
  if (resource !== "browse" || key === undefined) return null;
  const scope = /^([A-Z][A-Z0-9_]*)-[1-9][0-9]*$/.exec(key)?.[1];
  return scope === undefined ? null : { host: JIRA_HOST, workspace: site, scope, key };
}
