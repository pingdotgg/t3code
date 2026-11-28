import { issueLinkDefinition as jira } from "@t3tools/issue-tracker-jira/shared/issueUrl";
import { issueLinkDefinition as linear } from "@t3tools/issue-tracker-linear/shared/issueUrl";
import type { StandaloneIssueLinkDefinition } from "@t3tools/source-control-core/shared/definition";

/** In the server registry's order (`STANDALONE_TRACKERS`), so both recognize a link the same way. */
export const builtInStandaloneIssueLinkDefinitions: ReadonlyArray<StandaloneIssueLinkDefinition> = [
  linear,
  jira,
];
