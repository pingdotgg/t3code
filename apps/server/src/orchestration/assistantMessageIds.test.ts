import { MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { assistantSegmentMessageId } from "./assistantMessageIds.ts";

describe("assistantMessageIds", () => {
  it("scopes assistant message ids by turn so resumed sessions do not collide", () => {
    const baseKey = "assistant:session-1:segment:0";
    const turnOne = TurnId.make("turn-1");
    const turnTwo = TurnId.make("turn-2");

    expect(assistantSegmentMessageId(baseKey, 0, turnOne)).toBe(
      MessageId.make("assistant:turn-1:assistant:session-1:segment:0"),
    );
    expect(assistantSegmentMessageId(baseKey, 0, turnTwo)).toBe(
      MessageId.make("assistant:turn-2:assistant:session-1:segment:0"),
    );
    expect(assistantSegmentMessageId(baseKey, 0, turnOne)).not.toBe(
      assistantSegmentMessageId(baseKey, 0, turnTwo),
    );
  });
});
