/**
 * JiraCli - Effect service contract for `jira` CLI process interactions.
 *
 * Provides thin command execution helpers used by Jira workflow orchestration.
 *
 * @module JiraCli
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  JiraIssueViewInput,
  JiraIssueViewResult,
  JiraIssueCreateInput,
  JiraIssueCreateResult,
  JiraIssueMoveInput,
  JiraIssueMoveResult,
  JiraCommentAddInput,
  JiraCommentAddResult,
  JiraIssueListInput,
  JiraIssueListResult,
} from "@t3tools/contracts";
import type { ProcessRunResult } from "../../processRunner";
import type { JiraCliError } from "../Errors.ts";

/**
 * JiraCliShape - Service API for executing Jira CLI commands.
 */
export interface JiraCliShape {
  readonly execute: (input: {
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  }) => Effect.Effect<ProcessRunResult, JiraCliError>;

  readonly viewIssue: (
    input: JiraIssueViewInput,
  ) => Effect.Effect<JiraIssueViewResult, JiraCliError>;

  readonly createIssue: (
    input: JiraIssueCreateInput,
  ) => Effect.Effect<JiraIssueCreateResult, JiraCliError>;

  readonly moveIssue: (
    input: JiraIssueMoveInput,
  ) => Effect.Effect<JiraIssueMoveResult, JiraCliError>;

  readonly addComment: (
    input: JiraCommentAddInput,
  ) => Effect.Effect<JiraCommentAddResult, JiraCliError>;

  readonly listIssues: (
    input: JiraIssueListInput,
  ) => Effect.Effect<JiraIssueListResult, JiraCliError>;
}

/**
 * JiraCli - Service tag for Jira CLI process execution.
 */
export class JiraCli extends ServiceMap.Service<JiraCli, JiraCliShape>()(
  "t3/jira/Services/JiraCli",
) {}
