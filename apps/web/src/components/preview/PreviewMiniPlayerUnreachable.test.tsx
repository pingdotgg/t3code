import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PreviewMiniPlayerUnreachable } from "./PreviewMiniPlayerUnreachable";

describe("PreviewMiniPlayerUnreachable", () => {
  it("shows the failed host with Retry and Close", () => {
    const html = renderToStaticMarkup(
      <PreviewMiniPlayerUnreachable
        url="http://localhost:5173/app"
        description="ERR_CONNECTION_REFUSED"
        onRetry={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("localhost:5173");
    expect(html).toContain("Retry");
    expect(html).toContain("Close");
    expect(html).toContain("Connection refused");
    expect(html).toContain("pointer-events-auto");
    expect(html).toContain("truncate");
  });

  it("falls back to the raw URL when there is no host", () => {
    const html = renderToStaticMarkup(
      <PreviewMiniPlayerUnreachable
        url="file:///missing.html"
        description="ERR_FILE_NOT_FOUND"
        onRetry={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("file:///missing.html");
  });
});
