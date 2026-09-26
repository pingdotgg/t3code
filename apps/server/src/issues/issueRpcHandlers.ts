import {
  type EnvironmentAuthorizationError,
  type IssueCommentInput,
  type IssueListInput,
  type IssueRef,
  type IssueSetStateInput,
  ISSUE_WS_METHODS,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { IssueService } from "./IssueService.ts";

type ObserveRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;

const TRACE = { "rpc.aggregate": "issues" } as const;

/** The Issues RPCs, spread into the WebSocket handler group behind its scope check. */
export function makeIssueRpcHandlers(issues: IssueService["Service"], observe: ObserveRpcEffect) {
  return {
    [ISSUE_WS_METHODS.issuesList]: (input: IssueListInput) =>
      observe(ISSUE_WS_METHODS.issuesList, issues.list(input), TRACE),
    [ISSUE_WS_METHODS.issuesDetail]: (input: IssueRef) =>
      observe(ISSUE_WS_METHODS.issuesDetail, issues.detail(input), TRACE),
    [ISSUE_WS_METHODS.issuesComment]: (input: IssueCommentInput) =>
      observe(ISSUE_WS_METHODS.issuesComment, issues.comment(input), TRACE),
    [ISSUE_WS_METHODS.issuesSetState]: (input: IssueSetStateInput) =>
      observe(ISSUE_WS_METHODS.issuesSetState, issues.setState(input), TRACE),
  };
}
