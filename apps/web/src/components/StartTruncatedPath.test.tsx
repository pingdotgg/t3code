import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { StartTruncatedPath } from "./StartTruncatedPath";

describe("StartTruncatedPath", () => {
  it("keeps the filename at the visible end by truncating from the start", () => {
    const path = "apps/desktop/src/components/very/long/CommitDialog.tsx";

    const markup = renderToStaticMarkup(<StartTruncatedPath path={path} />);

    expect(markup).toContain('dir="rtl"');
    expect(markup).toMatch(
      /<bdi[^>]*>apps\/desktop\/src\/components\/very\/long\/CommitDialog\.tsx<\/bdi>/,
    );
    expect(markup).toContain("overflow-hidden");
    expect(markup).toContain("text-ellipsis");
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain("min-w-0");
  });

  it("shows the full path in a tooltip", () => {
    const path = "apps/desktop/src/components/very/long/CommitDialog.tsx";

    const markup = renderToStaticMarkup(<StartTruncatedPath path={path} />);

    expect(markup).toContain('data-slot="tooltip-trigger"');
    expect(markup).toContain("data-base-ui-tooltip-trigger");
    expect(markup).toContain(path);
  });
});
