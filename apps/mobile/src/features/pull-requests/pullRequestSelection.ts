import type { NavigationState } from "@react-navigation/native";
import { pullRequestListKey } from "./pullRequestList";

/** Follow the displayed PR through its detail routes and sheets, not an older stack entry. */
export function selectedPullRequestKey(state: Pick<NavigationState, "routes" | "index">) {
  for (let index = state.index; index >= 0; index--) {
    const route = state.routes[index];
    if (!route) continue;
    if (route.name === "Home" || route.name.startsWith("Thread")) return null;
    if (!route.name.startsWith("PullRequest")) continue;
    const params = route.params;
    if (
      params &&
      "environmentId" in params &&
      "host" in params &&
      "repository" in params &&
      "number" in params &&
      typeof params.environmentId === "string" &&
      typeof params.host === "string" &&
      typeof params.repository === "string" &&
      typeof params.number === "number"
    ) {
      return `${params.environmentId}:${pullRequestListKey({
        host: params.host,
        repository: params.repository,
        number: params.number,
      })}`;
    }
    if (route.name === "PullRequest") return null;
  }
  return null;
}
