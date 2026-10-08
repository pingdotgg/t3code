import { describe, expect, it } from "vite-plus/test";

import { resolveSubagentRowPresentation, subagentThreadTarget } from "./threadAgentsPresentation";

const base = {
  title: null,
  prompt: "Audit the timestamps",
  status: "running" as const,
  result: null,
  childThreadId: "thread-child" as never,
};

describe("resolveSubagentRowPresentation", () => {
  it("leads with progress while the agent is working", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      progress: "Reading files",
      result: "stale result",
    });

    expect(row.detail).toBe("Reading files");
    expect(row.tone).toBe("working");
    expect(row.live).toBe(true);
  });

  it("leads with the result once the agent has settled", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      status: "completed",
      progress: "Reading files",
      result: "Found two\n  problems",
    });

    expect(row.detail).toBe("Found two problems");
    expect(row.tone).toBe("completed");
    expect(row.statusLabel).toBe("Completed");
  });

  it("shows a failure's text, since that is where the error lands", () => {
    const row = resolveSubagentRowPresentation({ ...base, status: "failed", result: "Timed out" });

    expect(row.detail).toBe("Timed out");
    expect(row.tone).toBe("failed");
  });

  it("falls back to a trimmed prompt when the agent has no title", () => {
    const long = resolveSubagentRowPresentation({ ...base, prompt: "x".repeat(200) });
    const titled = resolveSubagentRowPresentation({ ...base, title: "Subagent: /root/my_worker" });

    expect(long.title).toHaveLength(80);
    expect(long.title.endsWith("...")).toBe(true);
    expect(titled.title).toBe("My Worker");
  });

  it("only offers a thread to open when the agent has one", () => {
    expect(resolveSubagentRowPresentation(base).canOpenThread).toBe(true);
    expect(resolveSubagentRowPresentation({ ...base, childThreadId: null }).canOpenThread).toBe(
      false,
    );
  });

  it("opens a task in a linked environment there, only when this app knows it", () => {
    const remote = {
      ...base,
      childThreadId: null,
      remoteChild: {
        environmentId: "environment-box" as never,
        threadId: "thread-on-box" as never,
        label: "Box",
      },
    };
    expect(resolveSubagentRowPresentation(remote).runsOn).toBe("Box");
    expect(resolveSubagentRowPresentation(remote, false).canOpenThread).toBe(false);
    expect(resolveSubagentRowPresentation(remote, true).canOpenThread).toBe(true);
    const here = "environment-here" as never;
    expect(subagentThreadTarget(remote, here, () => false)).toBeNull();
    expect(subagentThreadTarget(remote, here, (id) => id === "environment-box")).toEqual({
      environmentId: "environment-box",
      threadId: "thread-on-box",
    });
    expect(subagentThreadTarget(base, here, () => false)).toEqual({
      environmentId: here,
      threadId: "thread-child",
    });
  });

  it("uses the status label when there is nothing to report yet", () => {
    const row = resolveSubagentRowPresentation({ ...base, status: "pending" });

    expect(row.detail).toBeNull();
    expect(row.statusLabel).toBe("Working");
  });

  it("bounds long result previews without dropping the agent's status", () => {
    const row = resolveSubagentRowPresentation({
      ...base,
      status: "failed",
      result: "x".repeat(400),
    });
    expect(row.detail).toBe(`${"x".repeat(280)}…`);
    expect(row.statusLabel).toBe("Failed");
  });
});
