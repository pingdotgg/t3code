import { WorktreeSetupSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { setupLine } from "./worktreeSetup";

const snapshot = Schema.decodeUnknownSync(WorktreeSetupSnapshot);
const stage = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  status,
  startedAt: null,
  endedAt: null,
  percent: null,
  detail: null,
  tail: [],
  ...extra,
});
const base = {
  threadId: "th-1",
  startedAt: "2026-11-21T10:00:00.000Z",
  endedAt: null,
  branch: null,
  baseRef: null,
  worktreePath: null,
  setupScript: null,
  error: null,
  sequence: 3,
};

describe("setupLine", () => {
  it("names the running stage with its percent", () => {
    const line = setupLine(
      snapshot({
        ...base,
        phase: "running",
        stages: [stage("fetch", "done"), stage("checkout", "running", { percent: 42 })],
      }),
    );
    expect(line).toEqual({ kind: "running", text: "Check out files 42%" });
  });

  it("shows the failed stage, T3's error, the last three lines, and the terminal", () => {
    const line = setupLine(
      snapshot({
        ...base,
        phase: "failed",
        error: "Setup script exited with 1.",
        setupScript: { name: "setup", command: "sh x.sh", terminalId: "term-9" },
        stages: [
          stage("checkout", "done"),
          stage("setup-script", "failed", { tail: ["one", "two", "three", "four"] }),
        ],
      }),
    );
    expect(line).toEqual({
      kind: "failed",
      text: "Run setup script failed",
      error: "Setup script exited with 1.",
      tail: ["two", "three", "four"],
      terminalId: "term-9",
    });
  });

  it("shows nothing once setup is done", () => {
    expect(
      setupLine(snapshot({ ...base, phase: "done", stages: [stage("agent", "done")] })),
    ).toBeNull();
  });
});
