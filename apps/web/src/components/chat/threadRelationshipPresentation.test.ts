import { describe, expect, it } from "vite-plus/test";

import {
  agentsSectionHeading,
  relationshipDisplayStatus,
  relationshipDisplayTitle,
  relationshipSeatLabel,
} from "./threadRelationshipPresentation";

const specialist = { key: "dev-ui", label: "UI owner" };

describe("threadRelationshipPresentation", () => {
  it("keeps subagent children labeled Subagent even when a specialist is somehow present", () => {
    expect(
      relationshipSeatLabel({
        edgeKind: "subagent",
        isParent: false,
        specialist,
      }),
    ).toBe("Subagent");
    expect(
      relationshipDisplayTitle({
        title: "Explore sidebar",
        specialist,
        isSubagentChild: true,
      }),
    ).toBe("Explore sidebar");
  });

  it("uses the durable specialist label and @key for listed seats", () => {
    expect(
      relationshipSeatLabel({
        edgeKind: "fork",
        isParent: false,
        specialist,
      }),
    ).toBe("UI owner");
    expect(
      relationshipDisplayTitle({
        title: "Ship team view",
        specialist,
        isSubagentChild: false,
      }),
    ).toBe("@dev-ui Ship team view");
  });

  it("surfaces Needs you ahead of run status", () => {
    expect(
      relationshipDisplayStatus(
        {
          pendingRuntimeRequest: {
            id: "req",
            kind: "command",
            createdAt: null,
          } as never,
        },
        "running",
        () => "Working",
      ),
    ).toEqual({ kind: "needs_you", label: "Needs you" });
    expect(
      relationshipDisplayStatus({ pendingRuntimeRequest: null }, "waiting", () => "Waiting"),
    ).toEqual({ kind: "status", label: "Waiting", raw: "waiting" });
  });

  it("titles the Agents section from attention then running counts", () => {
    expect(agentsSectionHeading({ needsYou: 1, running: 2 })).toBe("Agents · 1 needs you");
    expect(agentsSectionHeading({ needsYou: 0, running: 2 })).toBe("Agents · 2 running");
    expect(agentsSectionHeading({ needsYou: 0, running: 0 })).toBe("Agents");
  });
});
