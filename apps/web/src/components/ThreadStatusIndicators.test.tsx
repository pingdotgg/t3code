import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThreadStatusLabel } from "./ThreadStatusIndicators";

describe("ThreadStatusLabel", () => {
  it("renders the Cursor icon for cursor CLI working sessions", () => {
    const html = renderToStaticMarkup(
      <ThreadStatusLabel
        status={{
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
          workingProvider: "cursorCli",
        }}
      />,
    );

    expect(html).toContain('data-provider-status-icon="cursor"');
  });

  it("renders the OpenCode icon for opencode completed sessions", () => {
    const html = renderToStaticMarkup(
      <ThreadStatusLabel
        status={{
          label: "Completed",
          colorClass: "text-emerald-600",
          dotClass: "bg-emerald-500",
          pulse: false,
          workingProvider: "opencode",
        }}
      />,
    );

    expect(html).toContain('data-provider-status-icon="opencode"');
  });
});
