/**
 * JiraManager - Effect service contract for Jira workflow orchestration.
 *
 * Orchestrates Jira operations by composing JiraCli and TextGeneration services.
 *
 * @module JiraManager
 */
import {
  type JiraIssueViewInput,
  type JiraIssueViewResult,
  type JiraIssueCreateInput,
  type JiraIssueCreateResult,
  type JiraIssueMoveInput,
  type JiraIssueMoveResult,
  type JiraCommentAddInput,
  type JiraCommentAddResult,
  type JiraIssueListInput,
  type JiraIssueListResult,
  type JiraGenerateTicketContentInput,
  type JiraGenerateTicketContentResult,
  type JiraGenerateProgressCommentInput,
  type JiraGenerateProgressCommentResult,
  type JiraGenerateCompletionSummaryInput,
  type JiraGenerateCompletionSummaryResult,
} from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { JiraManagerServiceError } from "../Errors.ts";

/**
 * JiraManagerShape - Service API for high-level Jira workflow actions.
 */
export interface JiraManagerShape {
  readonly viewIssue: (
    input: JiraIssueViewInput,
  ) => Effect.Effect<JiraIssueViewResult, JiraManagerServiceError>;

  readonly createIssue: (
    input: JiraIssueCreateInput,
  ) => Effect.Effect<JiraIssueCreateResult, JiraManagerServiceError>;

  readonly moveIssue: (
    input: JiraIssueMoveInput,
  ) => Effect.Effect<JiraIssueMoveResult, JiraManagerServiceError>;

  readonly addComment: (
    input: JiraCommentAddInput,
  ) => Effect.Effect<JiraCommentAddResult, JiraManagerServiceError>;

  readonly listIssues: (
    input: JiraIssueListInput,
  ) => Effect.Effect<JiraIssueListResult, JiraManagerServiceError>;

  readonly generateTicketContent: (
    input: JiraGenerateTicketContentInput,
  ) => Effect.Effect<JiraGenerateTicketContentResult, JiraManagerServiceError>;

  readonly generateProgressComment: (
    input: JiraGenerateProgressCommentInput,
  ) => Effect.Effect<JiraGenerateProgressCommentResult, JiraManagerServiceError>;

  readonly generateCompletionSummary: (
    input: JiraGenerateCompletionSummaryInput,
  ) => Effect.Effect<JiraGenerateCompletionSummaryResult, JiraManagerServiceError>;
}

/**
 * JiraManager - Service tag for Jira workflow orchestration.
 */
export class JiraManager extends ServiceMap.Service<JiraManager, JiraManagerShape>()(
  "t3/jira/Services/JiraManager",
) {}
