import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerBanner } from "./ComposerBanner";
import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerTasksBadge, ComposerTasksDrawer } from "./ComposerTasksBadge";

const progress = {
  step: "Attach task progress",
  completedSteps: 1,
  totalSteps: 3,
};
const steps = [
  { durationMs: 4_000, step: "Inspect the composer", status: "completed" as const },
  { step: "Attach task progress", status: "inProgress" as const },
  { step: "Verify the result", status: "pending" as const },
];

describe("ComposerTasksBadge", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the timer before the current task and progress in every layout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:02:05Z"));
    const workingStartedAt = "2026-08-29T12:00:00Z";
    for (const markup of [
      ...(["tab", "inline"] as const).map((placement) =>
        renderToStaticMarkup(
          <ComposerTasksBadge
            expanded={false}
            onToggle={() => undefined}
            placement={placement}
            progress={progress}
            steps={steps}
            activityStatus={{ kind: "working", startedAt: workingStartedAt }}
          />,
        ),
      ),
      renderToStaticMarkup(
        <ComposerTasksDrawer
          onCollapse={() => undefined}
          progress={progress}
          steps={steps}
          activityStatus={{ kind: "working", startedAt: workingStartedAt }}
        />,
      ),
    ]) {
      expect(markup).toContain('data-composer-working-status="true"');
      expect(markup).toContain("Working for");
      expect(markup).toContain("2m 5s");
      expect(markup.indexOf('data-composer-working-status="true"')).toBeLessThan(
        markup.indexOf('data-composer-task-current="true"'),
      );
      expect(markup.indexOf('data-composer-task-current="true"')).toBeLessThan(
        markup.indexOf('data-composer-task-progress="true"'),
      );
      expect(markup).not.toContain("lucide-list-todo");
      expect(markup).not.toContain("Dismiss tasks");
      expect(markup.match(/<button /g)).toHaveLength(1);
    }
  });

  it("renders active progress as an attached composer tab", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onToggle={() => undefined}
        progress={progress}
        steps={steps}
      />,
    );

    expect(markup).toContain('data-composer-tasks-badge="true"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("chat-composer-shoulder-tab");
    expect(markup).toContain("chat-composer-tasks-tab");
    expect(markup).toContain('data-composer-task-current="true"');
    expect(markup).toContain("min-w-0 flex-1 truncate");
    expect(markup).toContain("w-20");
    expect(markup).toContain("Tasks");
    expect(markup).toContain("Attach task progress");
    expect(markup).not.toContain("·");
    expect(markup).toContain("1/3");
    expect(markup).toContain("Current task: Attach task progress");
    expect(markup).toContain("lucide-list-todo");
    expect(markup).not.toContain("Dismiss tasks");
    expect(markup).not.toContain("lucide-x");
    expect(markup).toContain("lucide-chevron-down");
    expect(markup).toContain("rotate-180");
    expect(markup).toContain("bg-success");
    expect(markup).toContain("bg-primary");
    expect(markup).toContain("bg-muted-foreground/25");
  });

  it("composes tasks and stash as siblings without a reserved offset", () => {
    const markup = renderToStaticMarkup(
      <ComposerBanner.Dock>
        <ComposerTasksBadge
          expanded={false}
          onToggle={() => undefined}
          progress={progress}
          steps={steps}
        />
        <ComposerStashBadge
          count={2}
          menuOpen={false}
          pulseKey={0}
          pulsing={false}
          onToggleMenu={() => undefined}
        />
      </ComposerBanner.Dock>,
    );
    expect(markup).toContain('data-composer-banner-width="fill"');
    expect(markup).toContain('data-composer-banner-width="content"');
    expect(markup).toContain("Stashed prompts: 2. Open stash.");
    expect(markup).not.toContain("right-30");
  });

  it("has a compact inline fallback for occupied composer shoulders", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onToggle={() => undefined}
        placement="inline"
        progress={progress}
        steps={steps}
      />,
    );

    expect(markup).toContain("1/3");
    expect(markup).not.toContain("chat-composer-shoulder-tab");
    expect(markup).not.toContain("rounded-t-xl");
  });

  it("expands into a read-only attached task list", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksDrawer onCollapse={() => undefined} progress={progress} steps={steps} />,
    );

    expect(markup).toContain('data-chat-composer-tasks-drawer="true"');
    expect(markup).toContain('data-chat-composer-collapsed-controls="true"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="Collapse tasks. 1 of 3 complete."');
    expect(markup).toContain('aria-label="Task list. 1 of 3 complete."');
    expect(markup).toContain("<ul ");
    expect(markup.match(/<li /g)).toHaveLength(3);
    expect(markup).toContain('data-composer-tasks-list="true"');
    expect(markup).toContain("max-h-[min(24rem,40dvh)]");
    expect(markup).toContain('data-slot="scroll-area-viewport"');
    expect(markup).toContain("--scroll-area-overflow-y-start");
    expect(markup).toContain("--scroll-area-overflow-y-end");
    expect(markup).toContain("overscroll-contain");
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain("Inspect the composer");
    expect(markup).toContain('data-composer-task-duration="true"');
    expect(markup).toContain("w-10 text-right");
    expect(markup).toContain("4.0s");
    expect(markup).toContain("now");
    expect(markup).toContain("Attach task progress");
    expect(markup).toContain("Verify the result");
    expect(markup).toContain("lucide-list-todo");
    expect(markup).toContain("lucide-chevron-down");
    expect(markup).not.toContain("Dismiss tasks");
    expect(markup).toContain("bg-success");
    expect(markup).toContain("bg-primary");
    expect(markup).toContain("bg-muted-foreground/25");
  });

  it("drops the step segments when they would render as a blank gap", () => {
    const manySteps = Array.from({ length: 24 }, (_, index) => ({
      step: `Step ${index + 1}`,
      status: "pending" as const,
    }));
    const tab = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onToggle={() => undefined}
        progress={{ ...progress, totalSteps: manySteps.length }}
        steps={manySteps}
      />,
    );
    const inline = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onToggle={() => undefined}
        placement="inline"
        progress={{ ...progress, totalSteps: manySteps.length }}
        steps={manySteps}
      />,
    );

    expect(tab).not.toContain("w-20");
    expect(tab).toContain("1/24");
    expect(inline).not.toContain("w-10");
    expect(inline).toContain("1/24");
  });

  it("keeps every long-list task inside the bounded scroll region", () => {
    const longSteps = Array.from({ length: 20 }, (_, index) => ({
      step: `Task ${index + 1}`,
      status: index === 0 ? ("inProgress" as const) : ("pending" as const),
    }));
    const markup = renderToStaticMarkup(
      <ComposerTasksDrawer
        onCollapse={() => undefined}
        progress={{ step: "Task 1", completedSteps: 0, totalSteps: longSteps.length }}
        steps={longSteps}
      />,
    );

    const listStart = markup.indexOf('data-composer-tasks-list="true"');
    expect(listStart).toBeGreaterThan(markup.indexOf('aria-label="Collapse tasks.'));
    expect(markup.slice(listStart)).toContain("Task 20");
  });

  it("does not render an empty task count", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onToggle={() => undefined}
        progress={{ ...progress, totalSteps: 0 }}
        steps={steps}
      />,
    );

    expect(markup).toBe("");
  });
});
