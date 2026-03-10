import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { derivePendingUserInputs } from "./pendingUserInput";

function makeActivity(
  input: Omit<OrchestrationThreadActivity, "id" | "turnId" | "payload"> & {
    readonly id: string;
    readonly turnId?: OrchestrationThreadActivity["turnId"];
    readonly payload?: OrchestrationThreadActivity["payload"];
  },
): OrchestrationThreadActivity {
  return {
    ...input,
    id: EventId.makeUnsafe(input.id),
    payload: input.payload ?? null,
    turnId: input.turnId ?? null,
  };
}

describe("derivePendingUserInputs", () => {
  it("closes prompts when later unsequenced activities follow a sequenced request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-requested",
        createdAt: "2026-02-23T00:00:01.000Z",
        sequence: 10,
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-expired",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.expired",
        summary: "Pending question expired after app restart",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          reason: "server-restart",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });
});
