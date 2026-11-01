import { describe, expect, it } from "vite-plus/test";
import {
  applyTimelineDensity,
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

type WorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
const entry = (id: string, itemType: string) =>
  ({
    id,
    label: id,
    detail: id,
    itemType,
    tone: itemType === "reasoning" ? "thinking" : "tool",
    createdAt: "2026-01-01T00:00:00Z",
  }) as unknown as WorkEntry;
const work = (
  id: string,
  entries: WorkEntry[],
  isExpandedToolGroup = false,
): MessagesTimelineRow => ({
  kind: "work",
  id,
  createdAt: "2026-01-01T00:00:00Z",
  groupedEntries: entries,
  isExpandedToolGroup,
});
const assistant = (id: string, showAssistantMeta: boolean) =>
  ({
    kind: "message",
    id,
    createdAt: "2026-01-01T00:00:00Z",
    message: { id, role: "assistant", runId: "run-1" },
    showAssistantMeta,
  }) as unknown as MessagesTimelineRow;

describe("applyTimelineDensity", () => {
  const rows = [
    work("w1", [entry("r1", "reasoning"), entry("c1", "command_execution")]),
    assistant("m1", false),
    work("w2", [entry("c2", "command_execution"), entry("c3", "command_execution")]),
    assistant("m2", true),
  ];

  it("is identity when both settings are off", () => {
    expect(applyTimelineDensity(rows, { compactWorkLog: false, hideReasoning: false })).toBe(rows);
  });

  it("hides reasoning and commentary, then compacts to one updating line", () => {
    const result = applyTimelineDensity(rows, { compactWorkLog: true, hideReasoning: true });
    expect(result.map((row) => row.id)).toEqual(["w2", "m2"]);
    const last = result[0] as Extract<MessagesTimelineRow, { kind: "work" }>;
    expect(last.groupedEntries.map((e) => e.id)).toEqual(["c3"]);
    expect(last.isExpandedToolGroup).toBe(false);
    const entries = [entry("first", "command_execution"), entry("latest", "command_execution")];
    const derived = deriveMessagesTimelineRows({
      timelineEntries: entries.map((entry) => ({
        kind: "work",
        id: entry.id,
        createdAt: entry.createdAt,
        entry,
      })),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(
      applyTimelineDensity(derived, { compactWorkLog: true, hideReasoning: false })[0],
    ).toMatchObject({ kind: "work-toggle", summary: "latest", groupedEntries: entries });
  });

  it("hideReasoning alone keeps tool rows and the final answer", () => {
    const result = applyTimelineDensity(rows, { compactWorkLog: false, hideReasoning: true });
    expect(result.map((row) => row.id)).toEqual(["w1", "w2", "m2"]);
  });

  it("hides live commentary as soon as the next step starts", () => {
    const live = [
      work("w1", [entry("c1", "command_execution")]),
      assistant("m1", false),
      work("w2", [entry("c2", "command_execution")]),
    ];
    const result = applyTimelineDensity(live, { compactWorkLog: true, hideReasoning: true });
    expect(result.map((row) => row.id)).toEqual(["w2"]);
    const steer = {
      kind: "message",
      id: "steer",
      createdAt: "2026-01-01T00:00:00Z",
      message: { id: "steer", role: "user", inputIntent: "steer", runId: "run-1" },
    } as unknown as MessagesTimelineRow;
    const steered = applyTimelineDensity([live[1]!, steer, live[2]!], {
      compactWorkLog: true,
      hideReasoning: true,
    });
    expect(steered.map((row) => row.id)).toEqual(["steer", "w2"]);
  });

  it("keeps a terminal answer whose meta moved below trailing tools", () => {
    const settled = [
      assistant("m1", false),
      work("w1", [entry("c1", "command_execution")]),
      {
        kind: "assistant-meta",
        id: "assistant-meta:m1",
        createdAt: "2026-01-01T00:00:00Z",
        message: { id: "m1", role: "assistant", runId: "run-1" },
      } as unknown as MessagesTimelineRow,
    ];
    const result = applyTimelineDensity(settled, { compactWorkLog: false, hideReasoning: true });
    expect(result.map((row) => row.id)).toEqual(["m1", "w1", "assistant-meta:m1"]);
  });

  it("leaves a run the user expanded intact", () => {
    const expanded = [
      work("w1", [entry("c1", "command_execution"), entry("c2", "command_execution")], true),
      work("w2", [entry("c3", "command_execution")], true),
    ];
    const result = applyTimelineDensity(expanded, { compactWorkLog: true, hideReasoning: false });
    expect(result).toEqual(expanded);
    const live: MessagesTimelineRow = {
      kind: "work-live",
      id: "live",
      createdAt: "2026-01-01T00:00:00Z",
      entry: entry("reasoning", "reasoning"),
      groupedEntries: [entry("tool", "command_execution"), entry("reasoning", "reasoning")],
      groupId: "work-group:tool",
      expanded: true,
      active: true,
    };
    expect(
      applyTimelineDensity([live, ...expanded], { compactWorkLog: true, hideReasoning: true })[0],
    ).toMatchObject({
      kind: "thinking",
      groupId: "work-group:tool",
      expanded: true,
    });
  });
  it("keeps a streaming answer before the synthetic thinking indicator", () => {
    const result = applyTimelineDensity(
      [
        assistant("streaming-answer", false),
        { kind: "thinking", id: "live-activity", createdAt: null },
      ],
      { compactWorkLog: false, hideReasoning: true },
    );
    expect(result.map((row) => row.id)).toContain("streaming-answer");
  });

  it("keeps answered questions as compact work boundaries", () => {
    const question = {
      ...entry("question", "user_input_request"),
      questionAnswer: {},
    } as WorkEntry;
    const result = applyTimelineDensity(
      [work("question", [question]), work("tool", [entry("command", "command_execution")])],
      { compactWorkLog: true, hideReasoning: false },
    );
    expect(result.map((row) => row.id)).toEqual(["question", "tool"]);
  });
  it("removes reasoning-only disclosures and preserves mixed group identity", () => {
    const reasoning = entry("reasoning", "reasoning");
    const tools = [entry("read", "command_execution"), entry("test", "command_execution")];
    const derive = (entries: WorkEntry[]) =>
      deriveMessagesTimelineRows({
        timelineEntries: entries.map((entry) => ({
          kind: "work",
          id: entry.id,
          createdAt: entry.createdAt,
          entry,
        })),
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        expandedWorkGroupIds: new Set(["work-group:reasoning"]),
      });
    const options = { compactWorkLog: false, hideReasoning: true };
    expect(applyTimelineDensity(derive([reasoning]), options)).toEqual([]);
    const mixed = applyTimelineDensity(derive([reasoning, ...tools]), options);
    expect(mixed.find((row) => row.kind === "work-toggle")).toMatchObject({
      groupId: "work-group:reasoning",
      expanded: true,
      hiddenCount: 2,
    });
    expect(mixed.find((row) => row.kind === "work")).toMatchObject({ groupedEntries: tools });
  });
});
