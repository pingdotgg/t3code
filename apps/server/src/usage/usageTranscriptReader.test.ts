// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  kimiSessionIdFromTranscriptPath,
  listTranscriptFiles,
  readTranscriptRecords,
  resolveKimiDesktopDataDir,
} from "./usageTranscriptReader.ts";

function createKimiTranscript(lines: readonly string[]): {
  readonly filePath: string;
  readonly cleanup: () => void;
} {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-kimi-usage-"));
  const filePath = NodePath.join(
    dir,
    "sessions",
    "wd_demo_123",
    "session-123",
    "agents",
    "main",
    "wire.jsonl",
  );
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, `${lines.join("\n")}\n`);
  return { filePath, cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }) };
}

function usageRecord(input: {
  readonly time: number;
  readonly scope?: string;
  readonly model?: string;
  readonly inputOther?: number;
  readonly inputCacheRead?: number;
  readonly inputCacheCreation?: number;
  readonly output?: number;
}): string {
  return JSON.stringify({
    type: "usage.record",
    model: input.model ?? "kimi-code/k3",
    usage: {
      inputOther: input.inputOther ?? 100,
      inputCacheRead: input.inputCacheRead ?? 200,
      inputCacheCreation: input.inputCacheCreation ?? 30,
      output: input.output ?? 40,
    },
    usageScope: input.scope ?? "turn",
    time: input.time,
  });
}

describe("readTranscriptRecords for Kimi Code", () => {
  it("reads turn-scoped usage and respects the requested coverage bound", async () => {
    const { filePath, cleanup } = createKimiTranscript([
      JSON.stringify({ type: "metadata", created_at: 1_000 }),
      usageRecord({ time: 1_500, inputOther: 999 }),
      usageRecord({ time: 2_000 }),
      usageRecord({ time: 2_500, scope: "session", inputOther: 999 }),
      "not-json",
    ]);
    try {
      expect(await readTranscriptRecords(filePath, "kimi", 2_000)).toEqual([
        {
          provider: "kimi",
          timestampMs: 2_000,
          model: "kimi-code/k3",
          sessionId: "session-123",
          totals: {
            uncachedInputTokens: 100,
            cachedInputTokens: 200,
            cacheCreationTokens: 30,
            outputTokens: 40,
            reasoningTokens: 0,
          },
          reportedCostUsd: null,
          dedupeKey: null,
        },
      ]);
    } finally {
      cleanup();
    }
  });

  it("returns null when a transcript cannot be read", async () => {
    expect(
      await readTranscriptRecords(
        NodePath.join(NodeOS.tmpdir(), "t3-kimi-no-such-dir", "wire.jsonl"),
        "kimi",
      ),
    ).toBeNull();
  });
});

describe("kimiSessionIdFromTranscriptPath", () => {
  it("extracts the session id from TUI, desktop, and subagent paths", () => {
    expect(
      kimiSessionIdFromTranscriptPath(
        NodePath.join("home", "sessions", "wd_demo", "session-a", "agents", "main", "wire.jsonl"),
      ),
    ).toBe("session-a");
    expect(
      kimiSessionIdFromTranscriptPath(
        NodePath.join(
          "kimi-desktop",
          "runtime",
          "kimi-code",
          "home",
          "sessions",
          "wd_demo",
          "conv-b",
          "agents",
          "agent-2",
          "wire.jsonl",
        ),
      ),
    ).toBe("conv-b");
  });
});

describe("resolveKimiDesktopDataDir", () => {
  it("prefers an explicit desktop data directory", () => {
    expect(
      resolveKimiDesktopDataDir(
        { KIMI_DESKTOP_DATA_DIR: "/custom/desktop" },
        "linux",
        "/home/user",
      ),
    ).toBe("/custom/desktop");
  });

  it("uses Electron's platform data roots", () => {
    expect(
      resolveKimiDesktopDataDir(
        { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
        "win32",
        "C:\\Users\\me",
      ),
    ).toBe(NodePath.join("C:\\Users\\me\\AppData\\Roaming", "kimi-desktop"));
    expect(resolveKimiDesktopDataDir({}, "darwin", "/Users/me")).toBe(
      NodePath.join("/Users/me", "Library", "Application Support", "kimi-desktop"),
    );
    expect(resolveKimiDesktopDataDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/me")).toBe(
      NodePath.join("/xdg", "kimi-desktop"),
    );
  });

  it("falls back to the conventional Windows and Linux data roots", () => {
    expect(resolveKimiDesktopDataDir({}, "win32", "C:\\Users\\me")).toBe(
      NodePath.join("C:\\Users\\me", "AppData", "Roaming", "kimi-desktop"),
    );
    expect(resolveKimiDesktopDataDir({}, "linux", "/home/me")).toBe(
      NodePath.join("/home/me", ".config", "kimi-desktop"),
    );
  });
});

describe("listTranscriptFiles", () => {
  it("reports a missing root as a failed listing", async () => {
    const listing = await listTranscriptFiles(
      NodePath.join(NodeOS.tmpdir(), "t3-kimi-listing-missing"),
      0,
    );
    expect(listing).toEqual({ files: [], failedEntries: 1 });
  });

  it("lists recent wire transcripts and ignores non-jsonl files", async () => {
    const { filePath, cleanup } = createKimiTranscript([usageRecord({ time: 2_000 })]);
    NodeFS.writeFileSync(NodePath.join(NodePath.dirname(filePath), "state.json"), "{}");
    try {
      const root = NodePath.join(NodePath.dirname(filePath), "..", "..", "..");
      const listing = await listTranscriptFiles(root, 0);
      expect(listing.failedEntries).toBe(0);
      expect(listing.files.map((file) => file.path)).toEqual([filePath]);
    } finally {
      cleanup();
    }
  });
});
