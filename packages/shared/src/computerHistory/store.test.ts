// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import type { ComputerHistoryEvent } from "./events.ts";
import { appMatchesFilter, websiteMatchesFilter } from "./events.ts";
import {
  clearHistory,
  ensureComputerHistoryLayout,
  listTimeline,
  loadRecentContextMarkdown,
  runSummarizationPass,
  writeMemoryFile,
} from "./store.ts";
import { renderMemoryMarkdown, summarizeComputerHistory } from "./summarize.ts";
import { computerHistoryResourcesDir, computerHistorySegmentsDir } from "./paths.ts";

function event(
  partial: Partial<ComputerHistoryEvent> & Pick<ComputerHistoryEvent, "id" | "kind">,
): ComputerHistoryEvent {
  return {
    timestamp: partial.timestamp ?? new Date().toISOString(),
    ...partial,
  };
}

describe("computer history filters", () => {
  it("excludes matching apps in exclude mode", () => {
    expect(
      appMatchesFilter({ bundleIdentifier: "com.apple.mail" }, "exclude", ["com.apple.mail"]),
    ).toBe(false);
    expect(
      appMatchesFilter({ bundleIdentifier: "com.apple.Safari" }, "exclude", ["com.apple.mail"]),
    ).toBe(true);
  });

  it("requires an allowlist hit in includeOnly mode", () => {
    expect(appMatchesFilter({ name: "Code" }, "includeOnly", ["code"])).toBe(true);
    expect(appMatchesFilter({ name: "Slack" }, "includeOnly", ["code"])).toBe(false);
  });

  it("never allows private-browsing style urls", () => {
    expect(websiteMatchesFilter("chrome://newtab", "exclude", [])).toBe(false);
    expect(websiteMatchesFilter("about:privatebrowsing", "exclude", [])).toBe(false);
    expect(websiteMatchesFilter("https://mail.example/(Private)", "exclude", [])).toBe(false);
    expect(websiteMatchesFilter("https://example.com", "exclude", [])).toBe(true);
  });
});

describe("computer history summarizer", () => {
  it("builds 10min markdown with frontmatter", () => {
    const summary = summarizeComputerHistory({
      level: "10min",
      startedAt: new Date("2026-08-14T12:00:00.000Z"),
      events: [
        event({
          id: "1",
          kind: "appWindowChanged",
          app: { bundleIdentifier: "com.microsoft.VSCode", name: "Code" },
          window: { title: "store.ts — t3code" },
        }),
        event({
          id: "2",
          kind: "ax.focus_changed",
          app: { bundleIdentifier: "com.microsoft.VSCode", name: "Code" },
          ax: { role: "AXTextArea", description: "editor" },
        }),
      ],
    });
    const rendered = renderMemoryMarkdown(
      summary,
      "10min",
      new Date("2026-08-14T12:00:00.000Z"),
      "abcd",
    );
    expect(rendered.filename).toContain("10min");
    expect(rendered.contents).toContain("title:");
    expect(rendered.contents).toContain("## Memory summary");
    expect(rendered.contents).toContain("com.microsoft.VSCode");
  });
});

describe("computer history store", () => {
  it("summarizes closed segments, lists timeline, mirrors, and clears", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-ch-"));
    const codexHome = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-codex-"));
    await ensureComputerHistoryLayout(root);

    const startedAt = new Date(Date.now() - 15 * 60 * 1000);
    const segmentId = startedAt.toISOString().replaceAll(":", "-");
    const segmentDir = NodePath.join(computerHistorySegmentsDir(root), segmentId);
    await NodeFs.mkdir(segmentDir, { recursive: true });
    const events: ComputerHistoryEvent[] = [
      event({
        id: "a",
        kind: "sample.frontmost",
        timestamp: startedAt.toISOString(),
        app: { bundleIdentifier: "com.apple.Terminal", name: "Terminal" },
        window: { title: "zsh" },
      }),
      event({
        id: "b",
        kind: "keyboard.text_input",
        timestamp: new Date(startedAt.getTime() + 1000).toISOString(),
        app: { bundleIdentifier: "com.apple.Terminal", name: "Terminal" },
        text: "ls",
      }),
    ];
    await NodeFs.writeFile(
      NodePath.join(segmentDir, "events.jsonl"),
      events.map((item) => JSON.stringify(item)).join("\n"),
      "utf8",
    );
    await NodeFs.writeFile(
      NodePath.join(segmentDir, "metadata.json"),
      JSON.stringify({
        sessionID: "s1",
        segmentID: segmentId,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        endReason: "test",
        eventCount: events.length,
        suppressedEventCount: 0,
        platform: "darwin",
      }),
      "utf8",
    );

    const result = await runSummarizationPass(root, {
      mirrorToCodex: true,
      codexHome,
    });
    expect(result.created).toBeGreaterThanOrEqual(1);

    const timeline = await listTimeline(root);
    expect(timeline.items.length).toBeGreaterThanOrEqual(1);
    expect(timeline.items[0]?.applications).toContain("com.apple.Terminal");

    const mirrored = await NodeFs.readdir(
      NodePath.join(codexHome, "memories", "extensions", "skysight", "resources"),
    );
    expect(mirrored.some((name) => name.endsWith(".md"))).toBe(true);

    const context = await loadRecentContextMarkdown(root);
    expect(context).toContain("Computer History");

    await clearHistory(root, "all", { codexHome });
    const cleared = await listTimeline(root);
    expect(cleared.items).toEqual([]);
    const resources = await NodeFs.readdir(computerHistoryResourcesDir(root));
    expect(resources.filter((name) => name.endsWith(".md"))).toEqual([]);
  });

  it("writes memory files under resources", async () => {
    const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-ch-write-"));
    await ensureComputerHistoryLayout(root);
    const path = await writeMemoryFile(root, "# hi\n", "test.md", { mirrorToCodex: false });
    expect(path.endsWith("test.md")).toBe(true);
    expect(await NodeFs.readFile(path, "utf8")).toBe("# hi\n");
  });
});
