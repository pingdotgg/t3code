import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("aligns the warning and dismiss icons with the first line of a multi-line error", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error={"The first error line\ncontinues on a second line"}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="Dismiss error"');
    expect(markup).not.toContain("controlAlignment");
    expect(markup).toContain("flex gap-2 items-start");
    expect(markup).toContain("min-h-7 pt-1 sm:min-h-6 sm:pt-0.5");
    expect(markup).toContain("h-lh w-4");
    expect(markup).toContain("h-lh self-start");
  });

  it("renders the recovery action only when the caller has a complete recovery path", () => {
    const recoverableMarkup = renderToStaticMarkup(
      <ThreadErrorBanner error="Authentication failed" onContinueInNewThread={() => {}} />,
    );
    const genericMarkup = renderToStaticMarkup(<ThreadErrorBanner error="Network disconnected" />);

    expect(recoverableMarkup).toContain("Continue in a new thread");
    expect(genericMarkup).not.toContain("Continue in a new thread");
  });
});
