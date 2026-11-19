import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  agentEyesPlayback,
  bodyForDetail,
  deriveAgentEyesEvents,
  filterAgentEyesEvents,
  INITIAL_AGENT_EYES_PLAYBACK,
  stagedEvent,
} from "./agentEyes.logic";

let ordinal = 0;
type TurnItem = ThreadStructure["turnItems"][number];
const item = (fields: Record<string, unknown>): TurnItem =>
  ({
    id: `item-${(ordinal += 1)}`,
    ordinal,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: "2026-11-15T00:00:00.000Z",
    ...fields,
  }) as unknown as TurnItem;

const thread = () => {
  ordinal = 0;
  return [
    item({ type: "user_message", text: "Fix the login bug" }),
    item({ type: "assistant_message", text: "I'll check the auth module first. Then fix it." }),
    item({
      type: "file_change",
      fileName: "src/auth.ts",
      additions: 2,
      deletions: 1,
      diffStr: "-old\n+new\n+token = ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    }),
    item({ type: "command_execution", input: "pnpm test auth", output: "1 failed", exitCode: 1 }),
    item({ type: "command_execution", input: "ls", output: "src", exitCode: 0 }),
    item({
      type: "dynamic_tool",
      toolName: "browser_navigate",
      input: { url: "http://localhost" },
    }),
    item({
      type: "dynamic_tool",
      toolName: "mcp__t3-code__continuum_memory_update",
      input: { path: "TASKS.md" },
    }),
    item({ type: "reasoning", text: "hidden thoughts" }),
  ];
};

describe("deriveAgentEyesEvents", () => {
  it("lists what the agent did, with the agent's own preceding words and secrets removed", () => {
    const events = deriveAgentEyesEvents(thread());
    expect(events.map((event) => [event.kind, event.title, event.status])).toEqual([
      ["edit", "src/auth.ts", "done"],
      ["test", "pnpm test auth", "failed"],
      ["command", "ls", "done"],
      ["browser", "browser_navigate", "done"],
      ["memory", "continuum_memory_update", "done"],
    ]);
    expect(events[0]!.summary).toBe("Changed src/auth.ts (+2 −1).");
    expect(events[0]!.agentSaid).toBe("I'll check the auth module first.");
    expect(events[0]!.body).not.toContain("ghp_");
    expect(events[0]!.body).toContain("[REDACTED]");
    expect(events[1]!.summary).toBe("Ran `pnpm test auth`, which exited with code 1.");
  });

  it("classifies game and asset MCP calls and takes captures only from game tool output", () => {
    const capture = { captureId: "cap_viewport" };
    const events = deriveAgentEyesEvents([
      item({
        type: "dynamic_tool",
        toolName: "mcp__t3-code__continuum_game_capture",
        output: [{ text: JSON.stringify(capture) }],
      }),
      item({ type: "dynamic_tool", toolName: "mcp__t3-code__continuum_asset_list" }),
      item({ type: "dynamic_tool", toolName: "other_tool", output: capture }),
    ]);
    expect(events.map(({ kind, captureId }) => [kind, captureId])).toEqual([
      ["game", "cap_viewport"],
      ["game", undefined],
      ["tool", undefined],
    ]);
  });

  it("never carries an earlier turn's message into a new turn", () => {
    ordinal = 0;
    const events = deriveAgentEyesEvents([
      item({ type: "assistant_message", text: "Done with the old task." }),
      item({ type: "user_message", text: "Now run ls" }),
      item({ type: "command_execution", input: "ls", exitCode: 0 }),
    ]);
    expect(events[0]!.agentSaid).toBeNull();
  });
});

describe("filtering and detail", () => {
  it("filters by kind and searches titles, summaries, and bodies", () => {
    const events = deriveAgentEyesEvents(thread());
    expect(filterAgentEyesEvents(events, { kinds: new Set(["test"]), query: "" })).toHaveLength(1);
    expect(
      filterAgentEyesEvents(events, { kinds: new Set(), query: "localhost" }).map((e) => e.kind),
    ).toEqual(["browser"]);
  });

  it("shortens long bodies below full detail", () => {
    const body = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
    expect(bodyForDetail(body, "summary").split("\n")).toHaveLength(13);
    expect(bodyForDetail(body, "full")).toBe(body);
  });
});

describe("agentEyesPlayback", () => {
  it("follows live, pauses, steps, and replays back into live", () => {
    const events = deriveAgentEyesEvents(thread());
    expect(stagedEvent(events, INITIAL_AGENT_EYES_PLAYBACK)?.kind).toBe("memory");

    let state = agentEyesPlayback(INITIAL_AGENT_EYES_PLAYBACK, {
      type: "pause",
      eventId: events[2]!.id,
    });
    expect(stagedEvent(events, state)?.title).toBe("ls");
    state = agentEyesPlayback(state, { type: "step", events, offset: -1 });
    expect(stagedEvent(events, state)?.kind).toBe("test");

    state = agentEyesPlayback(state, { type: "replay", firstEventId: events[0]!.id });
    expect(state.mode).toBe("replay");
    for (let step = 0; step < events.length - 1; step += 1) {
      state = agentEyesPlayback(state, { type: "tick", events });
    }
    expect(stagedEvent(events, state)?.kind).toBe("memory");
    expect(agentEyesPlayback(state, { type: "tick", events })).toEqual(INITIAL_AGENT_EYES_PLAYBACK);
  });
});
