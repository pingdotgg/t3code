import { describe, expect, it } from "vite-plus/test";

import { faviconUrlForOrigin } from "./favicon";

describe("faviconUrlForOrigin", () => {
  it.each([
    "http://localhost:3000/",
    "http://127.0.0.1:3000/",
    "http://0.0.0.0:3000/",
    "http://devbox:3000/",
    "https://24x.xf.local/",
    "http://192.168.1.20:3000/",
    "http://[::]/",
    "http://[::ffff:192.168.1.20]/",
    "http://100.65.180.100:3000/",
    "https://devbox.example.ts.net/",
  ])("does not use the public provider for private origin %s", (url) => {
    expect(faviconUrlForOrigin(url)).toBeNull();
  });

  it("uses the public provider for a public origin", () => {
    expect(faviconUrlForOrigin("https://example.com/path", 32)).toBe(
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    );
  });
});
