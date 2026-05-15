import { describe, expect, it, vi } from "vitest";

import {
  parseListeningPidList,
  probeLocalPorts,
  stopLocalPorts,
  type LocalProcessControls,
} from "./localProcesses.ts";

function makeControls(overrides: Partial<LocalProcessControls> = {}): LocalProcessControls {
  return {
    currentPid: 999,
    listListeningPids: vi.fn(async () => []),
    killPid: vi.fn(),
    ...overrides,
  };
}

describe("localProcesses", () => {
  it("parses and deduplicates listening process ids", () => {
    expect(parseListeningPidList("123\n456\n123 ignored\n")).toEqual([123, 456]);
  });

  it("stops unique pids for unique ports", async () => {
    const controls = makeControls({
      listListeningPids: vi.fn(async (port) => (port === 5173 ? [111, 222, 111] : [])),
      killPid: vi.fn(),
    });

    await expect(stopLocalPorts({ ports: [5173, 5173, 3000] }, controls)).resolves.toEqual({
      results: [
        { port: 5173, killedPids: [111, 222], errors: [] },
        { port: 3000, killedPids: [], errors: [] },
      ],
    });
    expect(controls.killPid).toHaveBeenCalledTimes(2);
  });

  it("refuses to stop the current T3 Code process", async () => {
    const controls = makeControls({
      currentPid: 111,
      listListeningPids: vi.fn(async () => [111]),
      killPid: vi.fn(),
    });

    const result = await stopLocalPorts({ ports: [5173] }, controls);

    expect(result.results[0]?.killedPids).toEqual([]);
    expect(result.results[0]?.errors[0]).toContain("Refusing to stop");
    expect(controls.killPid).not.toHaveBeenCalled();
  });

  it("reports the current T3 Code process as listening when probing ports", async () => {
    const controls = makeControls({
      currentPid: 111,
      listListeningPids: vi.fn(async () => [111]),
    });

    await expect(probeLocalPorts({ ports: [5173] }, controls)).resolves.toEqual({
      results: [{ port: 5173, isListening: true, pids: [111], error: null }],
    });
  });
});
