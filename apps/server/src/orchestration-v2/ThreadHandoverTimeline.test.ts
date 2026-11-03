import {
  CheckpointId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { buildThreadHandoverTimeline } from "./ThreadHandoverTimeline.ts";

const threadId = ThreadId.make("handover-thread");
const instanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z");

type AnchorCreatedBy = "user" | "agent" | "system";

function anchorMessage(
  id: string,
  runId: string,
  text: string,
  createdBy: AnchorCreatedBy,
): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(id),
    threadId,
    runId: RunId.make(runId),
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdBy,
    creationSource: createdBy === "user" ? "web" : "server",
    createdAt: now,
    updatedAt: now,
  };
}

function assistantMessage(
  id: string,
  runId: string,
  text: string,
): OrchestrationV2ConversationMessage {
  return {
    ...anchorMessage(id, runId, text, "agent"),
    role: "assistant",
    creationSource: "provider",
  };
}

function run(
  ordinal: number,
  id: string,
  anchorMessageId: string,
  status: OrchestrationV2RunStatus = "completed",
  checkpointId: CheckpointId | null = null,
) {
  return {
    id: RunId.make(id),
    threadId,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "handover-model" },
    providerThreadId: null,
    userMessageId: MessageId.make(anchorMessageId),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: now,
    completedAt: status === "running" ? null : now,
    checkpointId,
    contextHandoffId: null,
  };
}

function projectionWith(
  partial: Partial<
    Pick<
      OrchestrationV2ThreadProjection,
      "runs" | "messages" | "subagents" | "checkpoints" | "runtimeRequests" | "thread"
    >
  >,
): OrchestrationV2ThreadProjection {
  return {
    runs: [],
    messages: [],
    subagents: [],
    checkpoints: [],
    runtimeRequests: [],
    thread: { id: threadId, pullRequests: [] },
    ...partial,
  } as unknown as OrchestrationV2ThreadProjection;
}

/** User-anchored runs at ordinals 1, 4, 5 with agent/server follow-ups grouped into epoch 1. */
function threeEpochProjection(
  overrides: {
    statuses?: Record<string, OrchestrationV2RunStatus>;
  } = {},
) {
  const status = (id: string) => overrides.statuses?.[id] ?? "completed";
  return projectionWith({
    // Deliberately out of ordinal order: partitioning must follow run ordinals.
    runs: [
      run(4, "r4", "m4", status("r4")),
      run(1, "r1", "m1", status("r1")),
      run(5, "r5", "m5", status("r5")),
      run(2, "r2", "m2", status("r2")),
      run(3, "r3", "m3", status("r3")),
    ],
    messages: [
      anchorMessage("m1", "r1", "Fix the login bug", "user"),
      anchorMessage("m2", "r2", "Steering: also cover the edge case", "agent"),
      anchorMessage("m3", "r3", "Scheduled wake-up nudge", "system"),
      anchorMessage("m4", "r4", "Now add tests", "user"),
      anchorMessage("m5", "r5", "Ship it", "user"),
    ],
  });
}

describe("buildThreadHandoverTimeline epoch partitioning", () => {
  it("returns no epochs for a thread with no runs", () => {
    const { epochs, markdown } = buildThreadHandoverTimeline(projectionWith({}));
    expect(epochs).toEqual([]);
    expect(markdown).toBe("");
  });

  it("partitions at each user-anchored run and groups later agent/server runs into that epoch", () => {
    const { epochs } = buildThreadHandoverTimeline(threeEpochProjection());

    expect(epochs).toHaveLength(3);
    expect(epochs.map((epoch) => epoch.id)).toEqual(["epoch-1", "epoch-2", "epoch-3"]);
    expect(
      epochs.map(({ fromRunOrdinal, toRunOrdinal }) => [fromRunOrdinal, toRunOrdinal]),
    ).toEqual([
      [1, 3],
      [4, 4],
      [5, 5],
    ]);

    // Only the user-created anchor message belongs to the epoch's record; agent/server
    // follow-up anchor messages are grouped in but not user asks.
    expect(epochs[0]!.userMessages).toEqual([
      { id: MessageId.make("m1"), text: "Fix the login bug" },
    ]);
    expect(epochs[1]!.userMessages).toEqual([{ id: MessageId.make("m4"), text: "Now add tests" }]);
    expect(epochs[2]!.userMessages).toEqual([{ id: MessageId.make("m5"), text: "Ship it" }]);
  });

  it("marks first and latest epochs essential and routine middle user epochs high", () => {
    const { epochs } = buildThreadHandoverTimeline(threeEpochProjection());

    expect(epochs[0]!.priority).toBe("essential");
    expect(epochs[0]!.reasons.join(" ")).toMatch(/first/i);
    expect(epochs[1]!.priority).toBe("high");
    expect(epochs[2]!.priority).toBe("essential");
    expect(epochs[2]!.reasons.join(" ")).toMatch(/latest/i);
  });

  it("marks an epoch essential when one of its runs failed or was interrupted", () => {
    for (const status of ["failed", "interrupted"] as const) {
      const { epochs } = buildThreadHandoverTimeline(
        threeEpochProjection({ statuses: { r4: status } }),
      );
      expect(epochs[1]!.priority).toBe("essential");
      expect(epochs[1]!.reasons.join(" ")).toMatch(new RegExp(status, "i"));
    }
  });

  it("marks a fully automated epoch background even when it is the first epoch", () => {
    const projection = projectionWith({
      runs: [run(1, "r1", "m1"), run(2, "r2", "m2"), run(3, "r3", "m3"), run(4, "r4", "m4")],
      messages: [
        anchorMessage("m1", "r1", "Scheduled task sweep", "agent"),
        anchorMessage("m2", "r2", "Scheduled task sweep follow-up", "system"),
        anchorMessage("m3", "r3", "Real user ask", "user"),
        // Not user-anchored: a user-anchored run must start its own epoch, so r4 groups
        // into the epoch opened by r3.
        anchorMessage("m4", "r4", "Automated follow-up ask", "agent"),
      ],
    });

    const { epochs } = buildThreadHandoverTimeline(projection);
    expect(epochs).toHaveLength(2);
    expect(epochs[0]).toMatchObject({ fromRunOrdinal: 1, toRunOrdinal: 2, priority: "background" });
    expect(epochs[0]!.userMessages).toEqual([]);
    expect(epochs[1]).toMatchObject({ fromRunOrdinal: 3, toRunOrdinal: 4, priority: "essential" });
  });

  it("marks the latest epoch essential and notes the reason when work is still pending", () => {
    const projection = threeEpochProjection();
    const withPendingRequest = {
      ...projection,
      runtimeRequests: [
        {
          id: "request-1",
          status: "pending",
          kind: "user_input",
          createdAt: now,
        },
      ] as unknown as OrchestrationV2ThreadProjection["runtimeRequests"],
    };

    const { epochs } = buildThreadHandoverTimeline(withPendingRequest);
    expect(epochs[2]!.priority).toBe("essential");
    expect(epochs[2]!.reasons.join(" ")).toMatch(/pending/i);
  });
});

describe("buildThreadHandoverTimeline epoch content", () => {
  const verbatimAsk = "Please fix the bug\n\n- keep `a && b`\n- don't touch *other* files";

  function contentProjection() {
    return threeEpochProjection();
  }

  it("preserves user message text verbatim", () => {
    const projection = contentProjection();
    const withVerbatimAsk = {
      ...projection,
      messages: projection.messages.map((message) =>
        message.id === MessageId.make("m1")
          ? anchorMessage("m1", "r1", verbatimAsk, "user")
          : message,
      ),
    };

    const { epochs } = buildThreadHandoverTimeline(withVerbatimAsk);
    expect(epochs[0]!.userMessages[0]!.text).toBe(verbatimAsk);
  });

  it("inlines full assistant reports for first and latest epochs only", () => {
    const projection = contentProjection();
    const withReports = {
      ...projection,
      messages: [
        ...projection.messages,
        assistantMessage("a1", "r1", "First epoch full report: fixed the login bug in auth.ts."),
        assistantMessage("a4", "r4", "High epoch report that must stay summarized."),
        assistantMessage("a5", "r5", "Latest epoch full report: shipped and green."),
      ],
    };

    const { epochs } = buildThreadHandoverTimeline(withReports);
    expect(epochs[0]!.assistantReports).toEqual([
      { runId: RunId.make("r1"), text: "First epoch full report: fixed the login bug in auth.ts." },
    ]);
    expect(epochs[1]!.assistantReports).toEqual([]);
    expect(epochs[2]!.assistantReports).toEqual([
      { runId: RunId.make("r5"), text: "Latest epoch full report: shipped and green." },
    ]);
  });

  it("collects subagent, checkpoint, and pull request references", () => {
    const checkpointId = CheckpointId.make("checkpoint-1");
    const projection = threeEpochProjection();
    const withReferences = {
      ...projection,
      runs: projection.runs.map((r) => (r.id === RunId.make("r3") ? { ...r, checkpointId } : r)),
      subagents: [
        {
          id: NodeId.make("subagent-1"),
          runId: RunId.make("r2"),
          childThreadId: ThreadId.make("child-thread-1"),
          title: "Investigate the flaky test",
          prompt: "Investigate the flaky test",
          status: "completed",
        },
        {
          id: NodeId.make("subagent-2"),
          runId: RunId.make("r3"),
          childThreadId: null,
          title: null,
          prompt: "Native child without a T3 thread",
          status: "completed",
        },
      ] as unknown as OrchestrationV2ThreadProjection["subagents"],
      checkpoints: [
        {
          id: checkpointId,
          runId: RunId.make("r3"),
          ref: "refs/t3/checkpoints/abc123",
          status: "ready",
        },
      ] as unknown as OrchestrationV2ThreadProjection["checkpoints"],
      thread: {
        id: threadId,
        pullRequests: [
          {
            host: "github.com",
            repository: "acme/web",
            number: 12,
            url: "https://github.com/acme/web/pull/12",
            source: "agent",
            linkedAt: "2026-10-03T12:00:00.000Z",
            snapshot: null,
            stack: null,
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection["thread"],
    };

    const { epochs } = buildThreadHandoverTimeline(withReferences);

    // Subagent with a T3 child thread is referenced by that thread; the provider-native
    // child without one is not.
    expect(epochs[0]!.references).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        id: "child-thread-1",
        label: "Investigate the flaky test",
      }),
    );
    expect(epochs[0]!.references.filter((reference) => reference.type === "subagent")).toHaveLength(
      1,
    );
    expect(epochs[0]!.references).toContainEqual(
      expect.objectContaining({
        type: "checkpoint",
        id: checkpointId,
        label: "refs/t3/checkpoints/abc123",
      }),
    );
    expect(epochs[0]!.references.every((reference) => reference.reason.length > 0)).toBe(true);

    // Pull requests are handoff state: they belong to the latest epoch.
    expect(epochs[2]!.references).toContainEqual(
      expect.objectContaining({
        type: "pull_request",
        id: "https://github.com/acme/web/pull/12",
        label: "acme/web#12",
      }),
    );
  });
});

describe("buildThreadHandoverTimeline markdown", () => {
  it("includes the complete timeline and details essential and high epochs without inlining the rest", () => {
    const projection = threeEpochProjection();
    const withAssistantMessages = {
      ...projection,
      messages: [
        ...projection.messages,
        assistantMessage("a1", "r1", "Full first-epoch report body that must appear verbatim."),
        assistantMessage("a2", "r2", "Routine grouped-run output that must not be inlined."),
        assistantMessage("a4", "r4", "High epoch report body that must not be inlined."),
      ],
    };

    const { markdown } = buildThreadHandoverTimeline(withAssistantMessages);

    // Complete timeline: every epoch shows up with its priority.
    for (const marker of ["epoch-1", "epoch-2", "epoch-3", "essential", "high"]) {
      expect(markdown).toContain(marker);
    }

    // Detailed sections carry user text and full reports for essential epochs…
    expect(markdown).toContain("Fix the login bug");
    expect(markdown).toContain("Now add tests");
    expect(markdown).toContain("Full first-epoch report body that must appear verbatim.");

    // …but routine command output and non-essential reports stay out of the document.
    expect(markdown).not.toContain("Routine grouped-run output that must not be inlined.");
    expect(markdown).not.toContain("High epoch report body that must not be inlined.");
  });

  it("surfaces references in the markdown", () => {
    const checkpointId = CheckpointId.make("checkpoint-md");
    const projection = threeEpochProjection();
    const withReferences = {
      ...projection,
      runs: projection.runs.map((r) => (r.id === RunId.make("r2") ? { ...r, checkpointId } : r)),
      checkpoints: [
        {
          id: checkpointId,
          runId: RunId.make("r2"),
          ref: "refs/t3/checkpoints/md123",
          status: "ready",
        },
      ] as unknown as OrchestrationV2ThreadProjection["checkpoints"],
      subagents: [
        {
          id: NodeId.make("subagent-md"),
          runId: RunId.make("r3"),
          childThreadId: ThreadId.make("child-thread-md"),
          title: "Investigate the flaky test",
          prompt: "Investigate the flaky test",
          status: "completed",
        },
      ] as unknown as OrchestrationV2ThreadProjection["subagents"],
      thread: {
        id: threadId,
        pullRequests: [
          {
            host: "github.com",
            repository: "acme/web",
            number: 12,
            url: "https://github.com/acme/web/pull/12",
            source: "agent",
            linkedAt: "2026-10-03T12:00:00.000Z",
            snapshot: null,
            stack: null,
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection["thread"],
    };

    const { markdown } = buildThreadHandoverTimeline(withReferences);
    expect(markdown).toContain("child-thread-md");
    expect(markdown).toContain("refs/t3/checkpoints/md123");
    expect(markdown).toContain("https://github.com/acme/web/pull/12");
  });
});

describe("buildThreadHandoverTimeline stress", () => {
  const runCount = 1000;
  // 1, 4, 7, … 1000 are user-anchored; the rest are agent/server follow-ups, so epochs mix
  // user asks with grouped automated runs.
  const createdByFor = (ordinal: number): AnchorCreatedBy =>
    ordinal % 3 === 1 ? "user" : ordinal % 3 === 2 ? "agent" : "system";
  const userOrdinals = Array.from({ length: runCount }, (_, i) => i + 1).filter(
    (ordinal) => createdByFor(ordinal) === "user",
  );

  // gcd(373, 1000) === 1, so multiplying by 373 modulo 1000 is a fixed bijection: a
  // deterministic scramble unrelated to ordinal order, with no randomness.
  const scrambled = (ordinals: number[]) =>
    [...ordinals].sort((a, b) => ((a * 373) % 1000) - ((b * 373) % 1000));

  function stressProjection(order: (ordinals: number[]) => number[]) {
    const ordinals = order(Array.from({ length: runCount }, (_, i) => i + 1));
    return projectionWith({
      runs: ordinals.map((ordinal) => run(ordinal, `stress-r${ordinal}`, `stress-m${ordinal}`)),
      messages: ordinals.map((ordinal) =>
        anchorMessage(
          `stress-m${ordinal}`,
          `stress-r${ordinal}`,
          `Ask or note number ${ordinal}`,
          createdByFor(ordinal),
        ),
      ),
      subagents: ordinals
        .filter((ordinal) => ordinal % 40 === 0)
        .map((ordinal) => ({
          id: NodeId.make(`stress-sub${ordinal}`),
          runId: RunId.make(`stress-r${ordinal}`),
          childThreadId: ThreadId.make(`stress-child${ordinal}`),
          title: `Stress child ${ordinal}`,
          prompt: `Stress child ${ordinal}`,
          status: "completed",
        })) as unknown as OrchestrationV2ThreadProjection["subagents"],
      checkpoints: ordinals
        .filter((ordinal) => ordinal % 50 === 0)
        .map((ordinal) => ({
          id: CheckpointId.make(`stress-cp${ordinal}`),
          runId: RunId.make(`stress-r${ordinal}`),
          ref: `refs/t3/checkpoints/stress${ordinal}`,
          status: "ready",
        })) as unknown as OrchestrationV2ThreadProjection["checkpoints"],
    });
  }

  it("covers 1000 mixed runs exactly once in ordinal order with nothing dropped, regardless of input run ordering", () => {
    const { epochs, markdown } = buildThreadHandoverTimeline(stressProjection((o) => o));

    // One epoch per user-anchored run.
    expect(epochs).toHaveLength(userOrdinals.length);

    // Every run is covered exactly once: epoch ranges chain contiguously across 1..1000.
    expect(epochs[0]!.fromRunOrdinal).toBe(1);
    expect(epochs[epochs.length - 1]!.toRunOrdinal).toBe(runCount);
    for (const [index, epoch] of epochs.entries()) {
      expect(epoch.toRunOrdinal).toBeGreaterThanOrEqual(epoch.fromRunOrdinal);
      if (index > 0) {
        expect(epoch.fromRunOrdinal).toBe(epochs[index - 1]!.toRunOrdinal + 1);
      }
    }

    // No user text is dropped: every user-anchored message appears exactly once, and all of
    // them are detailed into the markdown because every epoch here is essential or high.
    const userTexts = epochs.flatMap((epoch) => epoch.userMessages.map((message) => message.text));
    expect(userTexts).toHaveLength(userOrdinals.length);
    expect(new Set(userTexts).size).toBe(userTexts.length);
    expect(userTexts).toEqual(userOrdinals.map((ordinal) => `Ask or note number ${ordinal}`));
    for (const text of userTexts) {
      expect(markdown).toContain(text);
    }

    // No reference is dropped: every seeded subagent and checkpoint is attached to exactly
    // one epoch via its run.
    const references = epochs.flatMap((epoch) => epoch.references);
    expect(references).toHaveLength(runCount / 40 + runCount / 50);
    expect(new Set(references.map((reference) => reference.id)).size).toBe(references.length);
    expect(references.filter((reference) => reference.type === "subagent")).toHaveLength(
      runCount / 40,
    );
    expect(references.filter((reference) => reference.type === "checkpoint")).toHaveLength(
      runCount / 50,
    );

    // Output does not depend on the order runs arrive in: the scrambled input projection
    // produces byte-identical epochs and markdown.
    const rescrambled = buildThreadHandoverTimeline(stressProjection(scrambled));
    expect(rescrambled.epochs).toEqual(epochs);
    expect(rescrambled.markdown).toBe(markdown);
  });
});
