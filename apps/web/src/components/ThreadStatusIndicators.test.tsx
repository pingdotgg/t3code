import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ThreadStatusPill } from "./Sidebar.logic";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";

const workingStatus: ThreadStatusPill = {
  label: "Working",
  colorClass: "text-sky-600",
  dotClass: "bg-sky-500",
  pulse: true,
  presentation: "corner-badge",
};

describe("ThreadStatusLabel", () => {
  it("marks the compact working dot to retain its pulse under native vibrancy", () => {
    const html = renderToStaticMarkup(<ThreadStatusLabel compact status={workingStatus} />);

    expect(html).toContain("animate-status-pulse");
    expect(html).toContain("data-thread-status-pulse");
    expect(html).toContain("font-size:var(--app-sidebar-font-size)");
    expect(html).toContain("size-[0.583em]");
  });
});
