import { describe, expect, it } from "vite-plus/test";

import {
  AGENTS_RAIL_WIDTH,
  AGENTS_THREADS_PANE,
  resolveAgentsThreadsMaxWidth,
} from "./useAgentsPaneWidths";

describe("resolveAgentsThreadsMaxWidth", () => {
  it("lets wide windows reach the thread list's own cap", () => {
    expect(resolveAgentsThreadsMaxWidth(2400)).toBe(AGENTS_THREADS_PANE.max);
  });

  it("keeps the chat readable by shrinking the thread list beside the rail", () => {
    expect(resolveAgentsThreadsMaxWidth(1100)).toBe(1100 - AGENTS_RAIL_WIDTH - 420);
  });

  it("never drops below the thread list's minimum when the window cannot fit everything", () => {
    expect(resolveAgentsThreadsMaxWidth(600)).toBe(AGENTS_THREADS_PANE.min);
  });
});
