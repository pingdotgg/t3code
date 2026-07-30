import { ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  SidebarStatusGlyph,
  ThreadStatusLabel,
  ThreadWorktreeIndicator,
} from "./ThreadStatusIndicators";

describe("SidebarStatusGlyph", () => {
  it("renders the Forma pixel-grid working indicator", () => {
    const markup = renderToStaticMarkup(
      <ThreadStatusLabel
        status={{
          label: "Working",
          toneClass: "text-sky-600",
          glyph: "grid",
          pulse: true,
        }}
      />,
    );

    expect(markup).toContain('data-status-glyph="grid"');
    expect(markup).toContain('data-pixel-grid-variant="sidebar"');
    expect(markup.match(/data-slot="pixel-grid-loader-cell"/g)).toHaveLength(9);
    expect(markup).toContain(">Working<");
  });

  it("renders the custom Forma completion glyph", () => {
    const markup = renderToStaticMarkup(
      <SidebarStatusGlyph
        status={{
          label: "Completed",
          toneClass: "text-emerald-600",
          glyph: "check-check",
          pulse: false,
        }}
      />,
    );

    expect(markup).toContain('data-status-glyph="check-check"');
    expect(markup).toContain('data-icon="sidebar-completed"');
  });
});

describe("ThreadWorktreeIndicator", () => {
  it("renders the worktree folder and branch in an accessible label", () => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "feature/sidebar-indicator",
          worktreePath: "/tmp/worktrees/sidebar-indicator",
        }}
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      'aria-label="Worktree: sidebar-indicator (feature/sidebar-indicator)"',
    );
    expect(markup).toContain('data-testid="thread-worktree-thread-1"');
  });

  it.each([null, "", "   "])("renders nothing for an absent worktree path", (worktreePath) => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "main",
          worktreePath,
        }}
      />,
    );

    expect(markup).toBe("");
  });
});
