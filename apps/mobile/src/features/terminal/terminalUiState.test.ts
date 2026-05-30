import { beforeEach, describe, expect, it } from "vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  cacheTerminalFontSize,
  cacheTerminalGridSize,
  getCachedTerminalFontSize,
  getCachedTerminalGridSize,
  resetTerminalUiStateCaches,
} from "./terminalUiState";

describe("terminalUiState", () => {
  beforeEach(() => {
    resetTerminalUiStateCaches();
  });

  it("caches terminal font size using the shared normalization rules", () => {
    expect(getCachedTerminalFontSize()).toBeNull();
    expect(cacheTerminalFontSize(8.5)).toBe(8.5);
    expect(getCachedTerminalFontSize()).toBe(8.5);
    expect(cacheTerminalFontSize(100)).toBe(14);
    expect(getCachedTerminalFontSize()).toBe(14);
  });

  it("stores terminal grid sizes per terminal target", () => {
    const primaryTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "default",
    };
    const otherTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-2",
    };

    expect(getCachedTerminalGridSize(primaryTarget)).toBeNull();
    expect(
      cacheTerminalGridSize(primaryTarget, {
        cols: 107.9,
        rows: 33.2,
      }),
    ).toEqual({
      cols: 107,
      rows: 33,
    });
    expect(getCachedTerminalGridSize(primaryTarget)).toEqual({
      cols: 107,
      rows: 33,
    });
    expect(getCachedTerminalGridSize(otherTarget)).toBeNull();
  });
});
