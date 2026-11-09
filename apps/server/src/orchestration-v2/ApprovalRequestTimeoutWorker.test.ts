import { assert, describe, it } from "@effect/vitest";
import { CommandId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  approvalRequestTimeoutCommand,
  APPROVAL_REQUEST_TIMEOUT_REASON,
} from "./ApprovalRequestTimeoutWorker.ts";

const threadId = ThreadId.make("thread:approval-timeout");
const createdAt = DateTime.makeUnsafe("2026-11-09T10:00:00.000Z");
const request = {
  id: RuntimeRequestId.make("request:approval-timeout"),
  kind: "permission" as const,
  status: "pending" as const,
  createdAt,
};

describe("approvalRequestTimeoutCommand", () => {
  it("does nothing when unset or before the deadline", () => {
    assert.isNull(
      approvalRequestTimeoutCommand({
        threadId,
        request,
        timeoutSeconds: null,
        nowMs: Date.parse("2026-11-09T10:01:00.000Z"),
      }),
    );
    assert.isNull(
      approvalRequestTimeoutCommand({
        threadId,
        request,
        timeoutSeconds: 120,
        nowMs: Date.parse("2026-11-09T10:01:59.999Z"),
      }),
    );
  });

  it("declines an overdue approval with a stable command id", () => {
    assert.deepEqual(
      approvalRequestTimeoutCommand({
        threadId,
        request,
        timeoutSeconds: 120,
        nowMs: Date.parse("2026-11-09T10:02:00.000Z"),
      }),
      {
        type: "runtime-request.respond",
        commandId: CommandId.make(
          "approval-timeout:thread:approval-timeout:request:approval-timeout",
        ),
        threadId,
        requestId: request.id,
        decision: "decline",
      },
    );
    assert.equal(APPROVAL_REQUEST_TIMEOUT_REASON, "Approval request timed out and was declined.");
  });

  it("leaves user-input requests for the user", () => {
    assert.isNull(
      approvalRequestTimeoutCommand({
        threadId,
        request: { ...request, kind: "user_input" },
        timeoutSeconds: 1,
        nowMs: Date.parse("2026-11-09T11:00:00.000Z"),
      }),
    );
  });

  it("leaves internal requests for their owning workflow", () => {
    for (const kind of ["auth_refresh", "dynamic_tool_call"] as const) {
      assert.isNull(
        approvalRequestTimeoutCommand({
          threadId,
          request: { ...request, kind },
          timeoutSeconds: 1,
          nowMs: Date.parse("2026-11-09T11:00:00.000Z"),
        }),
      );
    }
  });
});
