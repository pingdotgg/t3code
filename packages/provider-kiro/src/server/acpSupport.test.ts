import { describe, expect, it } from "@effect/vitest";

import { kiroNormalizePermissionRequest } from "./acpSupport.ts";

describe("kiroNormalizePermissionRequest", () => {
  it("gives a review request the files Kiro lists only in its metadata", () => {
    const request = kiroNormalizePermissionRequest({
      sessionId: "session-1",
      toolCall: { toolCallId: "turn_approval_1", status: "pending", title: "Review changes" },
      options: [{ optionId: "accept", name: "Accept changes", kind: "allow_once" }],
      _meta: {
        kiro: {
          type: "turn_approval",
          files: [{ path: "/workspace/kiro-permission-probe.txt", toolCallId: "tool-1" }],
        },
      },
    });

    expect(request.toolCall.locations).toEqual([{ path: "/workspace/kiro-permission-probe.txt" }]);
    expect(request.toolCall.kind).toBe("edit");
  });
});
