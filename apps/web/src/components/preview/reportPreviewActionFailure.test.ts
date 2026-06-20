import { describe, expect, it, vi } from "vite-plus/test";

import { previewUrlFailureContext, reportPreviewActionFailure } from "./reportPreviewActionFailure";

describe("reportPreviewActionFailure", () => {
  it("logs safe preview target metadata without credentials or URL parameters", () => {
    const url =
      "https://user:password@example.com/preview/signed-secret-token?access_token=private#fragment";
    const cause = new Error("navigation failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportPreviewActionFailure(
      {
        operation: "navigate",
        ...previewUrlFailureContext(url),
      },
      cause,
    );

    expect(consoleError).toHaveBeenCalledWith(
      "[preview] action failed",
      {
        operation: "navigate",
        urlHostname: "example.com",
        urlLength: url.length,
        urlProtocol: "https:",
      },
      cause,
    );
    const loggedContext = consoleError.mock.calls[0]?.[1];
    expect(loggedContext).not.toHaveProperty("url");
    expect(JSON.stringify(loggedContext)).not.toContain("signed-secret-token");
    expect(JSON.stringify(loggedContext)).not.toContain("access_token=private");

    consoleError.mockRestore();
  });
});
