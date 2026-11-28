import { issueLinkDefinition as jira } from "@t3tools/issue-tracker-jira/shared/issueUrl";
import { issueLinkDefinition as linear } from "@t3tools/issue-tracker-linear/shared/issueUrl";

export const builtInStandaloneIssueLinkDefinitions = [linear, jira] as const;
