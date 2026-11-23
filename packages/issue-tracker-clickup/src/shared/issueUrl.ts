import { IssueTrackerKind } from "@t3tools/contracts";

export const CLICKUP_KIND = IssueTrackerKind.make("clickup");
export const CLICKUP_HOST = "app.clickup.com";

/**
 * A task link names neither its list nor its workspace, and task ids are unique across
 * workspaces. The server asks the task which list it is in; every account shares one workspace.
 */
export const CLICKUP_LINK_SCOPE = "task";
export const CLICKUP_LINK_WORKSPACE = "clickup";

/** `https://app.clickup.com/t/<task id>`. Custom task id links (`/t/<team>/<ID>`) stay ordinary. */
export function parseClickUpIssueUrl(url: URL) {
  if (url.protocol !== "https:" || url.host.toLowerCase() !== CLICKUP_HOST) return null;
  const [, resource, key, extra] = url.pathname.split("/");
  if (resource !== "t" || key === undefined || (extra !== undefined && extra !== "")) return null;
  if (!/^[a-z0-9]+$/i.test(key)) return null;
  return {
    host: CLICKUP_HOST,
    workspace: CLICKUP_LINK_WORKSPACE,
    scope: CLICKUP_LINK_SCOPE,
    key,
  };
}
