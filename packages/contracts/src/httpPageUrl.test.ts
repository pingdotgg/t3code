import { describe, expect, it } from "vite-plus/test";

import { httpPageUrl } from "./httpPageUrl.ts";

describe("httpPageUrl", () => {
  it("opens only http and https pages", () => {
    expect(httpPageUrl("https://accounts.google.com/o/oauth2/auth?x=1")?.host).toBe(
      "accounts.google.com",
    );
    expect(httpPageUrl("http://localhost:3000/auth")?.host).toBe("localhost:3000");
    expect(httpPageUrl("file:///tmp/auth")).toBeNull();
    expect(httpPageUrl("javascript:alert(1)")).toBeNull();
    expect(httpPageUrl("https://?state=x")).toBeNull();
    expect(httpPageUrl("not a url")).toBeNull();
  });
});
