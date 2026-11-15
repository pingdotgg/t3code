import { useAtomValue } from "@effect/atom-react";
import { holdIssuePages, issueCreateScopes } from "@t3tools/client-runtime/issue-list";
import type { IssueListInput } from "@t3tools/contracts";

import { useProjects } from "../../state/entities";
import { useIssueList } from "../../state/issues";
import { environmentServerConfigsAtom } from "../../state/server";
import { useWorkspaceState } from "../../state/workspace";

/** The Issues tab's resting listing; its answer names every tracker and what each can do. */
export const DEFAULT_ISSUE_LIST_INPUT = {
  state: "open",
  involvement: "all",
  limit: 50,
} as const satisfies IssueListInput;

const NO_PAGES = new Map<never, never>();

/** Every tracker scope a new issue can be filed in, across connected environments. */
export function useIssueCreateScopes() {
  const { environments } = useWorkspaceState();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const projects = useProjects();
  const targets = environments
    .filter(
      (environment) =>
        environment.connectionState === "connected" &&
        configs.get(environment.environmentId)?.environment.capabilities.issues === true,
    )
    .map((environment) => ({
      environmentId: environment.environmentId,
      input: DEFAULT_ISSUE_LIST_INPUT,
    }))
    .sort((left, right) => left.environmentId.localeCompare(right.environmentId));
  const list = useIssueList(targets);
  return {
    scopes: issueCreateScopes(holdIssuePages(list.answers, NO_PAGES), projects),
    isPending: list.isPending && list.answers.length === 0,
  };
}
