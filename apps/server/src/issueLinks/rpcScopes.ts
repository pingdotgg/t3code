import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ISSUE_LINKS_WS_METHODS,
} from "@t3tools/contracts";

/** Scopes for the fork's Issue link RPCs, spread into the upstream RPC scope table. */
export const ISSUE_LINK_RPC_SCOPES = {
  [ISSUE_LINKS_WS_METHODS.forThread]: AuthOrchestrationReadScope,
  [ISSUE_LINKS_WS_METHODS.threadsForIssues]: AuthOrchestrationReadScope,
  [ISSUE_LINKS_WS_METHODS.link]: AuthOrchestrationOperateScope,
  [ISSUE_LINKS_WS_METHODS.unlink]: AuthOrchestrationOperateScope,
  [ISSUE_LINKS_WS_METHODS.subscribeChanges]: AuthOrchestrationReadScope,
} as const;
