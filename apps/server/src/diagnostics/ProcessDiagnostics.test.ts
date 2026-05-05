import { describe, expect, it } from "vitest";

import { aggregateProcessDiagnostics, parsePosixProcessRows } from "./ProcessDiagnostics.ts";

describe("ProcessDiagnostics", () => {
  it("parses POSIX ps rows with full commands", () => {
    const rows = parsePosixProcessRows(
      [
        "  10     1    10 Ss      0.0   1024   01:02.03 /usr/bin/node server.js",
        "  11    10    10 S+     12.5  20480      00:04 codex app-server --config /tmp/one two",
      ].join("\n"),
    );

    expect(rows).toEqual([
      {
        pid: 10,
        ppid: 1,
        pgid: 10,
        status: "Ss",
        cpuPercent: 0,
        rssBytes: 1024 * 1024,
        elapsed: "01:02.03",
        command: "/usr/bin/node server.js",
      },
      {
        pid: 11,
        ppid: 10,
        pgid: 10,
        status: "S+",
        cpuPercent: 12.5,
        rssBytes: 20480 * 1024,
        elapsed: "00:04",
        command: "codex app-server --config /tmp/one two",
      },
    ]);
  });

  it("aggregates only descendants of the server process", () => {
    const diagnostics = aggregateProcessDiagnostics({
      serverPid: 100,
      readAt: new Date("2026-05-05T10:00:00.000Z"),
      rows: [
        {
          pid: 100,
          ppid: 1,
          pgid: 100,
          status: "S",
          cpuPercent: 0,
          rssBytes: 1_000,
          elapsed: "01:00",
          command: "t3 server",
        },
        {
          pid: 101,
          ppid: 100,
          pgid: 100,
          status: "S",
          cpuPercent: 1.5,
          rssBytes: 2_000,
          elapsed: "00:20",
          command: "codex app-server",
        },
        {
          pid: 102,
          ppid: 101,
          pgid: 100,
          status: "R",
          cpuPercent: 3.25,
          rssBytes: 4_000,
          elapsed: "00:05",
          command: "git status",
        },
        {
          pid: 200,
          ppid: 1,
          pgid: 200,
          status: "S",
          cpuPercent: 99,
          rssBytes: 8_000,
          elapsed: "00:01",
          command: "unrelated",
        },
        {
          pid: 201,
          ppid: 100,
          pgid: 100,
          status: "R",
          cpuPercent: 9,
          rssBytes: 9_000,
          elapsed: "00:00",
          command: "ps -axo pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,command=",
        },
      ],
    });

    expect(diagnostics.serverPid).toBe(100);
    expect(diagnostics.readAt).toBe("2026-05-05T10:00:00.000Z");
    expect(diagnostics.processCount).toBe(2);
    expect(diagnostics.totalRssBytes).toBe(6_000);
    expect(diagnostics.totalCpuPercent).toBe(4.75);
    expect(diagnostics.processes.map((process) => process.pid)).toEqual([101, 102]);
    expect(diagnostics.processes.map((process) => process.depth)).toEqual([0, 1]);
    expect(diagnostics.processes[0]?.childPids).toEqual([102]);
  });
});
