import { describe, expect, it } from "vite-plus/test";

import { formatThreadLink, parseThreadLinkHref } from "./threadLinks.ts";

describe("thread links", () => {
  it("round-trips ids that contain URL characters", () => {
    const link = formatThreadLink({
      environmentId: "studio mac",
      threadId: "home-launched:mcp:1/2",
      title: "Fix [the] build\nnow",
    });
    const href = /\]\((.+)\)$/.exec(link)![1]!;
    expect(link.startsWith("[Fix the build now](")).toBe(true);
    expect(parseThreadLinkHref(href)).toEqual({
      environmentId: "studio mac",
      threadId: "home-launched:mcp:1/2",
    });
  });

  it("rejects other links and malformed ones", () => {
    expect(parseThreadLinkHref("https://t3.codes")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/only-one")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/env/%E0%A4%A")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/%20/thread")).toBeNull();
  });
});
