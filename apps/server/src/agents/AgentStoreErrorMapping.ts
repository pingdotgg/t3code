import { AgentProfileInvalidError, AgentProfileRevisionConflictError } from "@t3tools/contracts";

import * as AgentProfileStore from "./AgentProfileStore.ts";
import * as AgentRuleStore from "./AgentRuleStore.ts";

export const mapAgentProfileStoreError = (
  error: AgentProfileStore.AgentProfileStoreFailure,
): AgentProfileRevisionConflictError | AgentProfileInvalidError => {
  if (error._tag === "AgentProfileStoreRevisionConflictError") {
    return new AgentProfileRevisionConflictError({
      id: error.id,
      scope: error.scope,
      ...(error.expectedRevision === undefined ? {} : { expectedRevision: error.expectedRevision }),
      ...(error.actualRevision === undefined ? {} : { actualRevision: error.actualRevision }),
    });
  }
  return new AgentProfileInvalidError({ detail: error.message });
};

export const mapAgentRuleStoreError = (
  error: AgentRuleStore.AgentRuleStoreFailure,
): AgentProfileRevisionConflictError | AgentProfileInvalidError => {
  if (error._tag === "AgentRuleStoreRevisionConflictError") {
    return new AgentProfileRevisionConflictError({
      id: error.id,
      scope: error.scope,
      ...(error.expectedRevision === undefined ? {} : { expectedRevision: error.expectedRevision }),
      ...(error.actualRevision === undefined ? {} : { actualRevision: error.actualRevision }),
    });
  }
  return new AgentProfileInvalidError({ detail: `Rule ${error.id}: ${error.message}` });
};
