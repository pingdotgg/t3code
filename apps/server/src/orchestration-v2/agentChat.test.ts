import { describe, expect, it } from "@effect/vitest";
import { MessageId, ProviderThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { agentAlreadyInstructed } from "./agentChat.ts";

const providerThreadId = ProviderThreadId.make("provider-thread-1");
const startedAt = DateTime.makeUnsafe("2026-11-24T00:00:00.000Z");

const previousRun = (status: "completed" | "failed" = "completed") => ({
  ordinal: 1,
  startedAt,
  providerThreadId,
  status,
  userMessageId: MessageId.make("message-1"),
});

const message = (text: string, agent?: string) => ({
  id: MessageId.make("message-1"),
  role: "user" as const,
  text,
  ...(agent === undefined ? {} : { context: { version: 1 as const, agent, records: [] } }),
});

const run = { ordinal: 2, providerThreadId, freshContext: undefined };

describe("agentAlreadyInstructed", () => {
  it("skips the instructions when the turn before went to the same agent", () => {
    expect(
      agentAlreadyInstructed(
        { runs: [previousRun()], messages: [message("Hi", "yoda")] },
        run,
        "yoda",
      ),
    ).toBe(true);
  });

  it("sends them again after another agent, a compaction, a failed turn, or a fresh context", () => {
    const cases = [
      { runs: [previousRun()], messages: [message("Hi")] },
      { runs: [previousRun()], messages: [message("Hi", "bb-8")] },
      { runs: [previousRun()], messages: [message("/compact", "yoda")] },
      { runs: [previousRun("failed")], messages: [message("Hi", "yoda")] },
      { runs: [], messages: [] },
    ];
    for (const projection of cases) {
      expect(agentAlreadyInstructed(projection, run, "yoda")).toBe(false);
    }
    expect(
      agentAlreadyInstructed(
        { runs: [previousRun()], messages: [message("Hi", "yoda")] },
        { ...run, freshContext: true },
        "yoda",
      ),
    ).toBe(false);
    expect(
      agentAlreadyInstructed(
        { runs: [previousRun()], messages: [message("Hi", "yoda")] },
        { ...run, providerThreadId: ProviderThreadId.make("provider-thread-2") },
        "yoda",
      ),
    ).toBe(false);
  });
});
