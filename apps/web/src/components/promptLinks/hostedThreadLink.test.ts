import { describe, expect, it } from "vite-plus/test";
import { hostedThreadLinkAction } from "./hostedThreadLink";
describe("bare hosted thread navigation", () => {
  it("waits for environment discovery on refresh", () => {
    expect(hostedThreadLinkAction("/env/thread", false, [])).toBe("wait");
  });
  it.each(["/env/first", "/env/second"])(
    "keeps connected sidebar navigation and refresh in the browser: %s",
    (path) => {
      expect(hostedThreadLinkAction(path, true, ["env"])).toBe("continue");
    },
  );
  it("requires a manual choice for unknown environments even with a remembered app opener", () => {
    expect(hostedThreadLinkAction("/unknown/thread", true, ["env"])).toBe("choose-manually");
  });
  it("keeps prompt links on the consent path", () => {
    expect(hostedThreadLinkAction("/env/thread?prompt=go", true, ["env"])).toBe("choose");
  });
});
