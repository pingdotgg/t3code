import { describe, expect, it } from "vite-plus/test";

import { isProcessAlive } from "./serverRuntimeState.ts";

describe("isProcessAlive", () => {
  it("never treats a process-group pid as a live server", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
