import { describe, expect, it } from "@effect/vitest";
import {
  AgentProfileId,
  AgentProfileRevision,
  AgentProfileRevisionConflictError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as AgentProfileStore from "./AgentProfileStore.ts";
import * as AgentRuleStore from "./AgentRuleStore.ts";
import { mapAgentProfileStoreError, mapAgentRuleStoreError } from "./AgentStoreErrorMapping.ts";

const id = AgentProfileId.make("reviewer");
const revision = AgentProfileRevision.make("a".repeat(64));
const isRevisionConflict = Schema.is(AgentProfileRevisionConflictError);

describe("agent store error mapping", () => {
  it("keeps profile conflicts as revision conflicts when one side is absent", () => {
    const error = mapAgentProfileStoreError(
      new AgentProfileStore.AgentProfileStoreRevisionConflictError({
        id,
        scope: "environment",
        expectedRevision: revision,
      }),
    );

    expect(isRevisionConflict(error)).toBe(true);
    if (!isRevisionConflict(error)) throw new Error("Expected conflict");
    expect(error).toMatchObject({ expectedRevision: revision });
    expect(error.actualRevision).toBeUndefined();
  });

  it("keeps rule conflicts as revision conflicts when both sides are absent", () => {
    const error = mapAgentRuleStoreError(
      new AgentRuleStore.AgentRuleStoreRevisionConflictError({
        id,
        scope: "project",
      }),
    );

    expect(isRevisionConflict(error)).toBe(true);
    if (!isRevisionConflict(error)) throw new Error("Expected conflict");
    expect(error.expectedRevision).toBeUndefined();
    expect(error.actualRevision).toBeUndefined();
  });
});
