import { describe, expect, it } from "vite-plus/test";

import { secretRequestPageUrl } from "./secretRequest.ts";

describe("secretRequestPageUrl", () => {
  it("opens only http and https pages", () => {
    expect(secretRequestPageUrl("https://accounts.google.com/o/oauth2/auth?x=1")?.host).toBe(
      "accounts.google.com",
    );
    expect(secretRequestPageUrl("javascript:alert(1)")).toBeNull();
    expect(secretRequestPageUrl("https://?state=x")).toBeNull();
    expect(secretRequestPageUrl("not a url")).toBeNull();
  });
});
