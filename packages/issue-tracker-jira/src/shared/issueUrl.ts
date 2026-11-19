import { IssueTrackerKind } from "@t3tools/contracts";

export const JIRA_KIND = IssueTrackerKind.make("jira");
/** Every Jira Cloud site is a subdomain of this; the site itself is the link's workspace. */
export const JIRA_HOST = "atlassian.net";

const SITE = /^([a-z0-9][a-z0-9-]*)\.atlassian\.net$/;
const KEY = /^([A-Z][A-Z0-9_]*)-[1-9][0-9]*$/;

/** `https://<site>.atlassian.net/browse/<PROJECT>-<n>`, keeping the site. */
export function parseJiraIssueUrl(url: URL) {
  if (url.protocol !== "https:" || url.port !== "") return null;
  const site = SITE.exec(url.hostname.toLowerCase())?.[1];
  const [, resource, key, ...rest] = url.pathname.split("/");
  if (site === undefined || resource !== "browse" || key === undefined) return null;
  if (rest.some((segment) => segment !== "")) return null;
  const scope = KEY.exec(key)?.[1];
  return scope === undefined ? null : { host: JIRA_HOST, workspace: site, scope, key };
}
