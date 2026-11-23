import { IssueTrackerKind } from "@t3tools/contracts";

export const CLICKUP_KIND = IssueTrackerKind.make("clickup");
export const CLICKUP_HOST = "app.clickup.com";

/**
 * A task link names neither its list nor its workspace, and task ids are unique across
 * workspaces. The server asks the task which list it is in; the empty workspace matches any.
 */
export const CLICKUP_LINK_SCOPE = "task";

/** `https://app.clickup.com/t/<task id>`. Custom task id links (`/t/<team>/<ID>`) stay ordinary. */
export function parseClickUpIssueUrl(url: URL) {
  if (url.protocol !== "https:" || url.host.toLowerCase() !== CLICKUP_HOST) return null;
  const key = /^\/t\/([a-z0-9]+)\/?$/i.exec(url.pathname)?.[1];
  return key === undefined
    ? null
    : { host: CLICKUP_HOST, workspace: "", scope: CLICKUP_LINK_SCOPE, key };
}
