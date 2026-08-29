import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

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
  it("renders active progress as an attached composer tab", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onDismiss={() => undefined}
        onToggle={() => undefined}
        progress={progress}
        steps={steps}
      />,
    );

    expect(markup).toContain('data-composer-tasks-badge="true"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("chat-composer-shoulder-tab");
    expect(markup).toContain("chat-composer-tasks-tab");
    expect(markup).toContain("rounded-t-xl");
    expect(markup).toContain("border-b-0");
    expect(markup).toContain("left-5.5");
    expect(markup).toContain("right-5.5");
    expect(markup).toContain('data-composer-task-current="true"');
    expect(markup).toContain("min-w-0 flex-1 truncate");
    expect(markup).toContain("w-20");
    expect(markup).toContain("Tasks");
    expect(markup).toContain("Attach task progress");
    expect(markup).not.toContain("·");
    expect(markup).toContain("1/3");
    expect(markup).toContain("Current task: Attach task progress");
    expect(markup).toContain("lucide-list-todo");
    expect(markup).toContain('aria-label="Dismiss tasks for this turn"');
    expect(markup).toContain("lucide-x");
    expect(markup).not.toContain("lucide-chevron");
    expect(markup).toContain("bg-success");
    expect(markup).toContain("bg-primary");
    expect(markup).toContain("bg-muted-foreground/25");
  });

  it("leaves room for the stash tab when both shoulders are present", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        hasTrailingShoulder
        onDismiss={() => undefined}
        onToggle={() => undefined}
        progress={progress}
        steps={steps}
      />,
    );

    expect(markup).toContain("right-30");
    expect(markup).not.toContain("right-5.5");
  });

  it("has a compact inline fallback for occupied composer shoulders", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onDismiss={() => undefined}
        onToggle={() => undefined}
        placement="inline"
        progress={progress}
        steps={steps}
      />,
    );

    expect(markup).toContain("rounded-sm");
    expect(markup).toContain("1/3");
    expect(markup).not.toContain("chat-composer-shoulder-tab");
    expect(markup).not.toContain("rounded-t-xl");
  });

  it("expands into a read-only attached task list", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksDrawer
        onCollapse={() => undefined}
        onDismiss={() => undefined}
        progress={progress}
        steps={steps}
      />,
    );

    expect(markup).toContain('data-chat-composer-tasks-drawer="true"');
    expect(markup).toContain('data-chat-composer-collapsed-controls="true"');
    expect(markup).not.toContain("data-variant");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="Collapse tasks. 1 of 3 complete."');
    expect(markup).toContain('aria-label="Task list. 1 of 3 complete."');
    expect(markup).toContain('role="list"');
    expect(markup).toContain('data-composer-tasks-list="true"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("max-h-[min(24rem,40dvh)]");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("overscroll-contain");
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain("focus-visible:ring-inset");
    expect(markup).toContain("Inspect the composer");
    expect(markup).toContain('data-composer-task-duration="true"');
    expect(markup).toContain("ml-auto w-10");
    expect(markup).toContain("4.0s");
    expect(markup).toContain("now");
    expect(markup).toContain("Attach task progress");
    expect(markup).toContain("Verify the result");
    expect(markup).toContain("lucide-list-todo");
    expect(markup).toContain("lucide-chevron-down");
    expect(markup).toContain('aria-label="Dismiss tasks for this turn"');
    expect(markup).not.toContain("bg-success");
    expect(markup).not.toContain("bg-primary");
    expect(markup).not.toContain("bg-muted-foreground/25");
  });

  it("drops the step segments when they would render as a blank gap", () => {
    const manySteps = Array.from({ length: 24 }, (_, index) => ({
      step: `Step ${index + 1}`,
      status: "pending" as const,
    }));
    const tab = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onDismiss={() => undefined}
        onToggle={() => undefined}
        progress={{ ...progress, totalSteps: manySteps.length }}
        steps={manySteps}
      />,
    );
    const inline = renderToStaticMarkup(
      <ComposerTasksBadge
        expanded={false}
        onDismiss={() => undefined}
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
        onDismiss={() => undefined}
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
        onDismiss={() => undefined}
        onToggle={() => undefined}
        progress={{ ...progress, totalSteps: 0 }}
        steps={steps}
      />,
    );

    expect(markup).toBe("");
  });
});
