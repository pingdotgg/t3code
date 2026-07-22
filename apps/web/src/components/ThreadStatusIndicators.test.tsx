import { ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ThreadStatusLabel,
  ThreadStatusText,
  ThreadWorktreeIndicator,
} from "./ThreadStatusIndicators";

describe("ThreadStatusLabel", () => {
  it("renders the Working label as an accessible staggered wave", () => {
    const markup = renderToStaticMarkup(
      <ThreadStatusLabel
        status={{
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        }}
      />,
    );

    expect(markup).toContain('aria-label="Working"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup.match(/animate-working-wave/g)).toHaveLength("Working".length);
    expect(markup).toContain("animation-delay:360ms");
  });

  it("leaves non-working status text static", () => {
    const markup = renderToStaticMarkup(
      <ThreadStatusLabel
        status={{
          label: "Connecting",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        }}
      />,
    );

    expect(markup).toContain("Connecting");
    expect(markup).not.toContain("animate-working-wave");
  });

  it("renders sidebar-specific status copy without animation", () => {
    const markup = renderToStaticMarkup(
      <ThreadStatusText label="Failed" className="inline whitespace-pre" />,
    );

    expect(markup).toContain("Failed");
    expect(markup).not.toContain("animate-working-wave");
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
