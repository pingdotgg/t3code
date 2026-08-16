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
  });
});
