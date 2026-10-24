import { EnvironmentId } from "@t3tools/contracts";
import { createRef, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

import { ReasoningTraceContent, SimpleWorkEntryRow } from "./TimelineWorkEntryRow";
import { LiveWorkEntryTimelineRow } from "./TimelineWorkGroupRows";
import ChatMarkdown from "../ChatMarkdown";
import {
  remarkThoughtPreview,
  THOUGHT_PREVIEW_MAX_LENGTH,
  THOUGHT_PREVIEW_SOURCE_MAX_LENGTH,
} from "./TimelineWorkEntryRow.logic";
import { TimelineRowActivityCtx, TimelineRowCtx, WorkGroupViewCtx } from "./timelineRowContext";

vi.mock(import("../../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), mathRenderingEnabled: true };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

function renderContent(content: ReactNode) {
  return renderToStaticMarkup(
    <TimelineRowCtx
      value={{
        citationRequest: null,
        listRef: createRef(),
        timestampFormat: "locale",
        routeThreadKey: "reasoning-preview-regression",
        threadRef: null,
        markdownCwd: undefined,
        resolvedTheme: "light",
        workspaceRoot: undefined,
        skills: [],
        runs: [],
        activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
        onRevertToTurnCount: () => {},
        onUseArtifactTemplate: () => {},
        onSendAppMessage: undefined,
        onAppFullscreenChange: () => {},
        onRunShellCommand: undefined,
        findActive: false,
        onImageExpand: () => {},
        onOpenTurnDiff: () => {},
        onOpenThread: () => {},
        workflowOpening: null,
        onForkFromRun: async () => {},
        onRollbackCheckpoint: () => {},
        onToggleTurnFold: () => {},
        onToggleAttemptFold: () => {},
        onFileOpen: () => {},
        onFileDownload: () => {},
        openPullRequest: () => {},
        onToggleWorkGroup: () => {},
        onToggleWorkEntry: () => {},
        onCancelWorktreeSetup: null,
        retryableWorkspacePreparationRunIds: new Set(),
        onRetryWorkspacePreparation: null,
        onWorktreeSetupWorkLocally: null,
        onOpenWorktreeSetupTerminal: null,
        workGroupViewState: { scrollPositions: new Map(), expandedEntries: new Set() },
      }}
    >
      <TimelineRowActivityCtx
        value={{
          isWorking: false,
          isCompacting: false,
          isRevertingCheckpoint: false,
          activeTurnInProgress: false,
          awaitingUser: false,
          isPreparingWorktree: false,
          latestRunId: null,
          backgroundWorktreeSetup: null,
        }}
      >
        {content}
      </TimelineRowActivityCtx>
    </TimelineRowCtx>,
  );
}

it("renders the entire expanded reasoning trace, including content beyond the preview", () => {
  const detail = `Opening paragraph.\n\n${"plain **fragment** ".repeat(10_000)}\n\nFinal reasoning conclusion.`;
  const html = renderContent(<ReasoningTraceContent entries={[reasoningEntry(detail)]} />);

  expect(html).toContain("Opening paragraph.");
  expect(html.match(/<strong>fragment<\/strong>/g)).toHaveLength(10_000);
  expect(html).toContain("Final reasoning conclusion.");
});

function renderedLabel(html: string) {
  return html
    .replace(/<span\b[^>]*data-slot="tooltip-trigger"[^>]*>[\s\S]*?<\/span>/g, "")
    .replace(/<[^>]*>/g, "");
}

function reasoningEntry(detail: string) {
  return {
    id: "reasoning-full-trace",
    createdAt: "2026-10-21T00:00:00.000Z",
    label: "Thought",
    tone: "thinking" as const,
    itemType: "reasoning" as const,
    toolLifecycleStatus: "completed" as const,
    detail,
  };
}

it("renders a compact reasoning row from a bounded prefix of a huge trace", () => {
  const prefix = "Opening **reasoning** with `code`.\n\n";
  const detail = `${prefix}${"plain **fragment** ".repeat(10_000)}\n\nFinal reasoning conclusion.`;
  const html = renderContent(
    <SimpleWorkEntryRow workEntry={reasoningEntry(detail)} workspaceRoot={undefined} />,
  );
  expect(html).toContain("Opening reasoning with code.");
  const visibleText = html.replace(/<[^>]*>/g, "");
  expect(visibleText).not.toContain("Final reasoning conclusion.");
  expect(visibleText.length).toBeLessThan(3_000);
});

// These constructs cross the former source cap, but close within bounded lookahead.
// Compare actual row output with the parser's full-source flattened label.
it.each([3_000, THOUGHT_PREVIEW_SOURCE_MAX_LENGTH - 200])(
  "keeps the leading rendered text of inline constructs with %i source characters",
  (length) => {
    const words = "word ".repeat(Math.ceil(length / 5));
    for (const [detail, opening] of [
      [
        `[Important reasoning](https://example.com/${"a".repeat(length)}) then continue`,
        "Important reasoning then continue",
      ],
      [`**Important reasoning ${words}end**`, "Important reasoning word "],
      [`*Important reasoning ${words}end*`, "Important reasoning word "],
      [`\`Important reasoning ${words}end\``, "Important reasoning word "],
      [
        `[Important reasoning][ref]\n\n${words}\n\n[ref]: /destination`,
        "Important reasoning word ",
      ],
    ] as const) {
      const html = renderContent(
        <SimpleWorkEntryRow workEntry={reasoningEntry(detail)} workspaceRoot={undefined} />,
      );
      const expected = renderContent(
        <ChatMarkdown
          cwd={undefined}
          inline
          text={detail}
          extraRemarkPlugins={[[remarkThoughtPreview, "Thought"]]}
        />,
      );
      const text = renderedLabel(html);
      expect(text).toBe(renderedLabel(expected));
      expect(text.startsWith(opening)).toBe(true);
      expect(text.length).toBeLessThanOrEqual(THOUGHT_PREVIEW_MAX_LENGTH);
    }
  },
);

it("keeps parser-owned math when its closing delimiter needs source lookahead", () => {
  const detail = `$x${" + x".repeat(1_000)}$ then continue`;
  const html = renderContent(
    <SimpleWorkEntryRow workEntry={reasoningEntry(detail)} workspaceRoot={undefined} />,
  );
  const expected = renderContent(
    <ChatMarkdown
      cwd={undefined}
      inline
      text={detail}
      extraRemarkPlugins={[[remarkThoughtPreview, "Thought"]]}
    />,
  );
  expect(html).toContain(expected);
  // SSR uses the formula's visible fallback until the lazy math renderer loads.
  expect(renderedLabel(html).startsWith("\\(x + x")).toBe(true);
  expect(renderedLabel(html)).toBe(renderedLabel(expected));
  expect(html).toContain('data-markdown-math="inline"');
});

it("does not read a closing delimiter or visible tail beyond source lookahead", () => {
  const detail = `**Important reasoning ${"word ".repeat(4_000)}end**\n\nHidden tail.`;
  const html = renderContent(
    <SimpleWorkEntryRow workEntry={reasoningEntry(detail)} workspaceRoot={undefined} />,
  );
  // Beyond lookahead we preserve the parser's literal interpretation rather than
  // guessing whether authored punctuation is an unfinished formatting delimiter.
  const text = renderedLabel(html);
  expect(text.startsWith("**Important reasoning word ")).toBe(true);
  expect(text.length).toBeLessThanOrEqual(THOUGHT_PREVIEW_MAX_LENGTH);
  expect(text).not.toContain("end");
  expect(text).not.toContain("Hidden tail.");
});

it("renders full reasoning when the row is expanded", () => {
  const detail = `Opening paragraph.\n\n${"plain **fragment** ".repeat(10_000)}\n\nFinal reasoning conclusion.`;
  const entry = reasoningEntry(detail);
  const html = renderContent(
    <WorkGroupViewCtx
      value={{
        state: { scrollPositions: new Map(), expandedEntries: new Set([entry.id]) },
        onToggleEntry: () => {},
      }}
    >
      <SimpleWorkEntryRow workEntry={entry} workspaceRoot={undefined} />
    </WorkGroupViewCtx>,
  );
  expect(html.match(/<strong>fragment<\/strong>/g)).toHaveLength(10_000);
  expect(html.replace(/<[^>]*>/g, "")).toContain("Final reasoning conclusion.");
});

it.each([false, true])("bounds live reasoning labels with thought row %s", (withThought) => {
  const detail = `Opening reasoning ${"fragment ".repeat(21_000)} Final conclusion.`;
  const entry = reasoningEntry(detail);
  const html = renderContent(
    <LiveWorkEntryTimelineRow
      row={{
        kind: "work-live",
        id: "live-reasoning",
        createdAt: entry.createdAt,
        entry,
        groupedEntries: [entry],
        groupId: "live-group",
        expanded: false,
        active: true,
        ...(withThought ? { thought: entry } : {}),
      }}
    />,
  );
  const text = html.replace(/<[^>]*>/g, "");
  expect(text).toContain("Opening reasoning fragment");
  expect(text).not.toContain("Final conclusion.");
  expect(text.length).toBeLessThan(THOUGHT_PREVIEW_MAX_LENGTH + 30);
});

it.each([false, true])("bounds live source parsing with thought row %s", (withThought) => {
  const entry = reasoningEntry(
    `[Important reasoning](https://example.com/${"a".repeat(THOUGHT_PREVIEW_SOURCE_MAX_LENGTH)})`,
  );
  const html = renderContent(
    <LiveWorkEntryTimelineRow
      row={{
        kind: "work-live",
        id: "live-source-boundary",
        createdAt: entry.createdAt,
        entry,
        groupedEntries: [entry],
        groupId: "live-group",
        expanded: false,
        active: true,
        ...(withThought ? { thought: entry } : {}),
      }}
    />,
  );
  // Beyond lookahead, an unresolved link retains the parser's literal syntax.
  // Parsing or compacting the full source would resolve it and lose the brackets.
  expect(html.replace(/<[^>]*>/g, "").startsWith("[Important reasoning](")).toBe(true);
});

it.each([
  ["completed", "Thought"],
  ["inProgress", "Thinking"],
] as const)("keeps the empty %s reasoning fallback", (toolLifecycleStatus, fallback) => {
  const html = renderContent(
    <SimpleWorkEntryRow
      workEntry={{ ...reasoningEntry(""), toolLifecycleStatus }}
      workspaceRoot={undefined}
    />,
  );
  expect(html.replace(/<[^>]*>/g, "")).toContain(fallback);
});
