import { describe, expect, it } from "vite-plus/test";

import { formatPreviewUrl } from "./previewUrlPresentation";

describe("formatPreviewUrl", () => {
  it("formats signed asset URLs with the environment label and decoded filename", () => {
    expect(
      formatPreviewUrl({
        url: "http://127.0.0.1:3773/api/assets/token/architecture%20brief.pdf",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBe("Local environment · architecture brief.pdf");
  });

  it("does not alias assets from another origin", () => {
    expect(
      formatPreviewUrl({
        url: "https://example.com/api/assets/token/report.pdf",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBe("example.com");
  });

  it("formats regular preview URLs as their exact host", () => {
    expect(
      formatPreviewUrl({
        url: "http://127.0.0.1:5173/dashboard",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBe("127.0.0.1:5173");
  });

  it("does not compact non-http URLs", () => {
    expect(
      formatPreviewUrl({
        url: "file:///tmp/report.pdf",
        environmentLabel: "Local environment",
        environmentHttpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toBeNull();
  });
});
