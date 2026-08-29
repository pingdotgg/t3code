import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerActivityRow } from "./ComposerActivityStatus";
import { ComposerTasksBadge, ComposerTasksDrawer } from "./ComposerTasksBadge";

const progress = { step: "Verify the banners", completedSteps: 1, totalSteps: 2 };
const steps = [
  { step: "Unify the layout", status: "completed" as const },
  { step: "Verify the banners", status: "inProgress" as const },
];

describe("ComposerActivityStatus", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["loading", "syncing"] as const)(
    "shows %s instead of a timer in every activity layout",
    (phase) => {
      const status = { kind: "sync" as const, phase };
      const label = phase === "loading" ? "Loading messages..." : "Syncing messages...";
      for (const element of [
        <ComposerActivityRow key="standalone" status={status} />,
        <ComposerTasksBadge
          key="summary"
          progress={progress}
          steps={steps}
          activityStatus={status}
          expanded={false}
          onToggle={() => {}}
        />,
        <ComposerTasksDrawer
          key="expanded"
          progress={progress}
          steps={steps}
          activityStatus={status}
          onCollapse={() => {}}
        />,
      ]) {
        const markup = renderToStaticMarkup(element);
        expect(markup).toContain(label);
        expect(markup).toContain('role="status"');
        expect(markup.match(/data-composer-sync-status=/g)).toHaveLength(1);
        expect(markup).not.toContain("Working for");
        expect(markup).not.toContain("data-composer-working-status");
      }
    },
  );

  it("uses the original turn start for the elapsed time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:02:05Z"));
    const markup = renderToStaticMarkup(
      <ComposerActivityRow status={{ kind: "working", startedAt: "2026-08-29T12:00:00Z" }} />,
    );
    expect(markup).toContain("Working for");
    expect(markup).toContain("2m 5s");
    expect(markup).not.toContain("data-composer-sync-status");
  });

  it("does not invent an elapsed time before the turn start is known", () => {
    const markup = renderToStaticMarkup(
      <ComposerActivityRow status={{ kind: "working", startedAt: null }} />,
    );
    expect(markup).toContain("Working…");
    expect(markup).not.toContain("Working for");
  });
});
