/**
 * SSR assertions for the agent-run card redesign.
 *
 * Everything checked here is a defect the audit reproduced from a screenshot of
 * the running app, so the markup — not just the pure helpers — has to pin it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AgentRun, AgentRunFeedLine } from "../../agentRuns.ts";

const stopState = { enabled: true, requests: {} as Record<string, number> };

// The card resolves its thread from the route; SSR has no router.
vi.mock("./agentRunStop.ts", () => ({
  useAgentRunStop: () => ({
    enabled: stopState.enabled,
    requests: stopState.requests,
    stopRuns: () => {},
  }),
}));

import { AgentRunCard } from "./AgentRunCard.tsx";

function feedLine(overrides: Partial<AgentRunFeedLine> = {}): AgentRunFeedLine {
  return {
    id: "p1",
    createdAt: "2026-07-18T00:00:01.000Z",
    updatedAt: "2026-07-18T00:00:01.000Z",
    kind: "tool",
    tool: "Bash",
    text: "Idle 30 seconds",
    repeat: 1,
    ...overrides,
  };
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    taskId: "task-1",
    rowId: "a1",
    createdAt: "2026-07-18T00:00:00.000Z",
    settledAt: null,
    turnId: null,
    title: "general-purpose",
    phase: "running",
    ambient: false,
    detailsUnavailable: false,
    feed: [],
    ...overrides,
  };
}

describe("AgentRunCard header", () => {
  it("lets only the title grow, and floors it so chips give up space first", () => {
    const markup = renderToStaticMarkup(
      <AgentRunCard run={run({ toolUses: 6, totalTokens: 26_000 })} />,
    );
    expect(markup).toContain("min-w-0 flex-1 truncate font-medium text-foreground");
    expect(markup).toContain("@[16rem]/agent-run:min-w-40");
    // The card is its own container: chips are gated on the card, not the viewport.
    expect(markup).toContain("@container/agent-run");
    expect(markup).toContain("hidden @[22rem]/agent-run:inline-flex");
    expect(markup).toContain("hidden @[26rem]/agent-run:inline-flex");
    expect(markup).not.toContain("sm:inline-block");
  });

  it("reserves a fixed slot for the elapsed clock so the row cannot twitch", () => {
    const markup = renderToStaticMarkup(<AgentRunCard run={run()} />);
    expect(markup).toContain("w-14 shrink-0 truncate text-right");
  });

  it("uses one pulsing dot, not three, and guards it for reduced motion", () => {
    const markup = renderToStaticMarkup(<AgentRunCard run={run()} />);
    expect(markup).toContain("animate-status-pulse");
    expect(markup).toContain("motion-reduce:animate-none");
    expect(markup.match(/animate-status-pulse/g)).toHaveLength(1);
  });

  it("announces one status vocabulary on the row", () => {
    expect(renderToStaticMarkup(<AgentRunCard run={run()} />)).toContain(
      'aria-label="Running: general-purpose"',
    );
    expect(
      renderToStaticMarkup(<AgentRunCard run={run({ phase: "done", durationMs: 4000 })} />),
    ).toContain('aria-label="Completed: general-purpose"');
  });

  it("opens a live transcript card and leaves every other first state closed", () => {
    // Live in the transcript: the work log is visible where there is room for it.
    expect(renderToStaticMarkup(<AgentRunCard run={run({ feed: [feedLine()] })} />)).toContain(
      'aria-expanded="true"',
    );
    // Settled history, and every tracker row: closed.
    expect(
      renderToStaticMarkup(<AgentRunCard run={run({ phase: "done", durationMs: 4000 })} />),
    ).toContain('aria-expanded="false"');
    expect(renderToStaticMarkup(<AgentRunCard density="compact" run={run()} />)).toContain(
      'aria-expanded="false"',
    );
  });

  it("never shows an expanded body with nothing in it", () => {
    const markup = renderToStaticMarkup(<AgentRunCard run={run()} />);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Starting…");
  });
});

describe("AgentRunCard stop control", () => {
  it("is a labelled button with a stop glyph, never the bare square", () => {
    const markup = renderToStaticMarkup(<AgentRunCard run={run()} />);
    expect(markup).toContain('aria-label="Stop general-purpose"');
    expect(markup).toContain("lucide-circle-stop");
    // It is a real Button: the house focus ring and 44px coarse-pointer target.
    expect(markup).toContain("focus-visible:ring-offset-background");
    expect(markup).toContain("pointer-coarse:after:min-h-11");
    expect(markup).toContain("disabled:opacity-64");
  });

  it("disables itself and spins while a stop is pending", () => {
    stopState.requests = { "task-1": Date.now() };
    try {
      const markup = renderToStaticMarkup(<AgentRunCard run={run()} />);
      expect(markup).toContain("disabled");
      expect(markup).toContain("animate-spin");
      expect(markup).toContain("Stopping…");
    } finally {
      stopState.requests = {};
    }
  });

  it("is absent for a settled run", () => {
    const markup = renderToStaticMarkup(
      <AgentRunCard run={run({ phase: "done", durationMs: 4000 })} />,
    );
    expect(markup).not.toContain("lucide-circle-stop");
    expect(markup).toContain("4s");
  });

  it("offers Jump only where the tracker wired one", () => {
    expect(renderToStaticMarkup(<AgentRunCard density="compact" run={run()} />)).not.toContain(
      "Jump to",
    );
    expect(
      renderToStaticMarkup(<AgentRunCard density="compact" onJump={() => {}} run={run()} />),
    ).toContain('aria-label="Jump to general-purpose in the transcript"');
  });
});

describe("AgentRunCard compact row", () => {
  it("is two lines: identity, then the coalesced tail of the feed", () => {
    const markup = renderToStaticMarkup(
      <AgentRunCard
        density="compact"
        run={run({ feed: [feedLine({ id: "p0", text: "one" }), feedLine({ repeat: 2 })] })}
      />,
    );
    expect(markup).toContain("Idle 30 seconds");
    // Only the tail: the popover is not a log viewer.
    expect(markup).not.toContain(">one<");
  });

  it("says what a run with no feed yet is doing", () => {
    expect(renderToStaticMarkup(<AgentRunCard density="compact" run={run()} />)).toContain(
      "Starting…",
    );
  });

  it("carries the ambient badge with a real tooltip trigger", () => {
    const markup = renderToStaticMarkup(
      <AgentRunCard density="compact" run={run({ ambient: true })} />,
    );
    expect(markup).toContain("background");
    // A Badge with a tooltip trigger, not a bare `title=` on a span.
    expect(markup).toContain("data-base-ui-tooltip-trigger");
    expect(markup).not.toContain('title="Housekeeping');
  });
});

describe("AgentRunCard feed line", () => {
  it("separates the actor from the object instead of concatenating them", () => {
    const markup = renderToStaticMarkup(
      <AgentRunCard density="compact" run={run({ feed: [feedLine()] })} />,
    );
    expect(markup).toContain("Bash");
    expect(markup).toContain("Idle 30 seconds");
    expect(markup).toContain("·");
    expect(markup).not.toContain("Bash Idle 30 seconds");
  });

  it("shows a repeat count on a coalesced line that is no longer live", () => {
    const markup = renderToStaticMarkup(
      <AgentRunCard
        density="compact"
        run={run({ phase: "stopped", feed: [feedLine({ repeat: 3 })] })}
      />,
    );
    expect(markup).toContain("×3");
  });

  it("truncates with a tooltip trigger rather than losing the tail of the line", () => {
    const markup = renderToStaticMarkup(
      <AgentRunCard density="compact" run={run({ feed: [feedLine()] })} />,
    );
    expect(markup).toContain("min-w-0 flex-1 truncate");
    expect(markup).toContain('data-slot="tooltip-trigger"');
  });

  it("renders a nested agent as itself, with no elapsed suffix and no echoed prompt", () => {
    const markup = renderToStaticMarkup(
      <AgentRunCard
        density="compact"
        run={run({
          prompt: "Two-phase smoke test with detailed output",
          feed: [feedLine({ kind: "subagent", tool: "probe:toolchain", text: "" })],
        })}
      />,
    );
    expect(markup).toContain("probe:toolchain");
    expect(markup).not.toContain("(65s)");
    expect(markup).not.toContain("Two-phase smoke test");
  });
});
