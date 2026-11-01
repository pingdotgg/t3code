import { describe, expect, it } from "vite-plus/test";

import {
  normalizePreviewUrl,
  PreviewUrlNormalizationError,
  resolveAddressBarInput,
  previewPdfAssetUrl,
  resolveSearchUrlTemplate,
} from "./preview.ts";

describe("previewPdfAssetUrl", () => {
  it.each([
    "http://localhost:6497",
    "https://host.tailnet.test",
    "https://environment.tunnel.test",
  ])("loads PDF bytes through the client's connection at %s", (base) => {
    expect(
      previewPdfAssetUrl(
        "http://127.0.0.1:14537/api/assets/signed-token/Study%20guide.PDF?revision=2#page=8",
        base,
      ),
    ).toBe(`${base}/api/assets/signed-token/Study%20guide.PDF?revision=2#page=8`);
  });

  it.each([
    "http://localhost:6497/api/assets/token/index.html",
    "https://example.com/paper.pdf",
    "file:///api/assets/token/paper.pdf",
    "invalid",
  ])("leaves non-asset documents on their browser session: %s", (url) => {
    expect(previewPdfAssetUrl(url, "https://environment.test")).toBeNull();
  });

  it.each(["another-environment.test", "127.0.0.2.example.com", "128.0.0.1"])(
    "preserves matching PDF URLs on unrelated host %s",
    (host) => {
      const source = `https://${host}/api/assets/token/guide.pdf?revision=2#page=3`;
      expect(previewPdfAssetUrl(source, "https://environment.test")).toBe(source);
    },
  );

  it("keeps URLs from the connected environment", () => {
    const source = "https://environment.test/api/assets/token/guide.pdf#page=2";
    expect(previewPdfAssetUrl(source, "https://environment.test")).toBe(source);
  });

  it.each(["127.0.0.2", "localhost.", "[::1]"])(
    "remaps local assets on %s through the client connection",
    (host) => {
      expect(
        previewPdfAssetUrl(
          `http://${host}:14537/api/assets/token/guide.pdf?revision=2#page=3`,
          "https://remote.test",
        ),
      ).toBe("https://remote.test/api/assets/token/guide.pdf?revision=2#page=3");
    },
  );
});

describe("resolveAddressBarInput", () => {
  it.each([
    ["localhost:3000/?next=https://example.com", "http://localhost:3000/?next=https://example.com"],
    ["127.0.0.1:3000/#https://example.com", "http://127.0.0.1:3000/#https://example.com"],
    ["example.com/https://example.org", "https://example.com/https://example.org"],
  ])("opens the outer address when it contains another URL: %s", (input, expected) => {
    expect(resolveAddressBarInput(input)).toBe(expected);
  });

  it("opens what users type as addresses", () => {
    expect(resolveAddressBarInput("localhost:5173")).toBe("http://localhost:5173/");
    expect(resolveAddressBarInput("127.0.0.1:3000/path")).toBe("http://127.0.0.1:3000/path");
    expect(resolveAddressBarInput("my-box.tailnet.ts.net")).toBe("https://my-box.tailnet.ts.net/");
    expect(resolveAddressBarInput("cnn.com")).toBe("https://cnn.com/");
    expect(resolveAddressBarInput("devbox:8080")).toBe("https://devbox:8080/");
    expect(resolveAddressBarInput(" https://example.com/a b ")).toBe("https://example.com/a%20b");
    expect(resolveAddressBarInput("example.com:8080")).toBe("https://example.com:8080/");
    expect(resolveAddressBarInput("[::1]:3000")).toBe("http://[::1]:3000/");
    expect(resolveAddressBarInput("192.168.1.5:3000")).toBe("https://192.168.1.5:3000/");
  });

  it("searches for text that is not an address", () => {
    expect(resolveAddressBarInput("weather")).toBe("https://duckduckgo.com/?q=weather");
    expect(resolveAddressBarInput("how to center a div")).toBe(
      "https://duckduckgo.com/?q=how%20to%20center%20a%20div",
    );
    expect(resolveAddressBarInput("what is cnn.com")).toBe(
      "https://duckduckgo.com/?q=what%20is%20cnn.com",
    );
    expect(resolveAddressBarInput("what is https://example.com")).toBe(
      "https://duckduckgo.com/?q=what%20is%20https%3A%2F%2Fexample.com",
    );
    expect(resolveAddressBarInput("what is 10:30")).toBe(
      "https://duckduckgo.com/?q=what%20is%2010%3A30",
    );
    expect(resolveAddressBarInput("note: buy milk")).toBe(
      "https://duckduckgo.com/?q=note%3A%20buy%20milk",
    );
  });

  it("still rejects empty input and unsupported schemes", () => {
    expect(() => resolveAddressBarInput("  ")).toThrow(PreviewUrlNormalizationError);
    expect(() => resolveAddressBarInput("ftp://example.com")).toThrow(PreviewUrlNormalizationError);
    expect(() => resolveAddressBarInput("mailto:alice@example.com")).toThrow(
      PreviewUrlNormalizationError,
    );
    expect(() => resolveAddressBarInput("data:text/plain,hello")).toThrow(
      PreviewUrlNormalizationError,
    );
    for (const input of ["ftp:21", "tel:5551234"]) {
      expect(() => resolveAddressBarInput(input)).toThrow(PreviewUrlNormalizationError);
    }
    expect(resolveAddressBarInput("devbox:8080")).toBe("https://devbox:8080/");
  });

  it("searches with the given template and still opens addresses directly", () => {
    const google = resolveSearchUrlTemplate({
      browserSearchEngine: "google",
      browserCustomSearchUrl: "",
    });
    expect(resolveAddressBarInput("how to center a div", google)).toBe(
      "https://www.google.com/search?q=how%20to%20center%20a%20div",
    );
    expect(resolveAddressBarInput("cnn.com", google)).toBe("https://cnn.com/");
    expect(resolveAddressBarInput("a&b", "https://search.example/?q=%s&lang=en")).toBe(
      "https://search.example/?q=a%26b&lang=en",
    );
  });
});

describe("resolveSearchUrlTemplate", () => {
  it("uses a valid custom template and falls back to DuckDuckGo for an unusable one", () => {
    expect(
      resolveSearchUrlTemplate({
        browserSearchEngine: "custom",
        browserCustomSearchUrl: " https://search.example/?q=%s ",
      }),
    ).toBe("https://search.example/?q=%s");
    for (const browserCustomSearchUrl of [
      "https://search.example/?q=",
      "javascript:alert('%s')",
      "https://%s.example.com/",
      "https://%s@search.example/?q=%s",
    ]) {
      expect(
        resolveSearchUrlTemplate({ browserSearchEngine: "custom", browserCustomSearchUrl }),
      ).toBe("https://duckduckgo.com/?q=%s");
    }
  });
});

describe("normalizePreviewUrl", () => {
  it("rejects unparseable input without retaining credentials or tokens", () => {
    const rawUrl = "https://user:password@example.com:bad/path?access_token=secret#fragment";
    try {
      normalizePreviewUrl(rawUrl);
      expect.unreachable("expected URL normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PreviewUrlNormalizationError);
      expect(error).toMatchObject({
        inputLength: rawUrl.length,
        reason: "parse",
        protocol: "https:",
      });
      expect(error).not.toHaveProperty("rawUrl");
      expect((error as PreviewUrlNormalizationError).cause).toBeInstanceOf(Error);
      expect((error as PreviewUrlNormalizationError).message).not.toContain(
        ((error as PreviewUrlNormalizationError).cause as Error).message,
      );
      expect((error as PreviewUrlNormalizationError).message).not.toMatch(
        /user|password|access_token|secret|fragment/,
      );
    }
  });
});
