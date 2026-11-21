import { describe, expect, it } from "vite-plus/test";

import { isSafeImageSource } from "./imageSource";

describe("which images a comment may load", () => {
  it("Given sources that reach the machine's own services, when they are checked, then each is refused", () => {
    for (const src of [
      "http://127.0.0.1:3813/api/secret.png",
      "http://127.1/x.png",
      "http://2130706433/x.png",
      "http://localhost:5173/x.png",
      "http://app.localhost/x.png",
      "http://localhost./x.png",
      "http://[::1]:80/x.png",
      "http://[::ffff:127.0.0.1]/x.png",
      "http://0.0.0.0/x.png",
      "/attachments/x.png",
      "//127.0.0.1/x.png",
      "x.png",
      "file:///etc/passwd",
      undefined,
    ]) {
      expect(isSafeImageSource(src), String(src)).toBe(false);
    }
  });

  it("Given a public or inline source, when it is checked, then it is allowed", () => {
    expect(isSafeImageSource("https://example.com/badge.svg")).toBe(true);
    expect(isSafeImageSource("data:image/png;base64,AAAA")).toBe(true);
  });
});
