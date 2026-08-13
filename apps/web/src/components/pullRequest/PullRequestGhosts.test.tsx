import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestDetailGhost } from "./PullRequestGhosts";

describe("PullRequestDetailGhost", () => {
  it("matches the expanded pull request chrome and summary metadata geometry", () => {
    const markup = renderToStaticMarkup(<PullRequestDetailGhost />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Loading pull request"');
    expect(markup).toContain('data-pull-request-detail-ghost=""');
    expect(markup).toContain('data-pull-request-detail-ghost-meta=""');
    expect(markup.match(/grid min-h-8 grid-cols-\[6rem_minmax\(0,1fr\)\]/g)).toHaveLength(3);
    expect(markup).toContain("border-t border-border/60");
    expect(markup).not.toContain("bg-muted-foreground/10");
    expect(markup).not.toContain("bg-muted/40");
  });
});
