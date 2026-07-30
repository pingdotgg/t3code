import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { UnsentDraftIndicator } from "./ThreadUnsentDraftIndicator";

describe("ThreadUnsentDraftIndicator", () => {
  it("renders an accessible unsent-message marker", () => {
    const markup = renderToStaticMarkup(<UnsentDraftIndicator showTooltip={false} />);

    expect(markup).toContain('aria-label="Unsent message"');
    expect(markup).toContain('data-testid="thread-unsent-draft-indicator"');
  });
});
