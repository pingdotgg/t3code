import { describe, expect, it } from "vite-plus/test";

import type { Artifact } from "../store/artifacts";
import { classifyLink, findArtifact } from "./links";

const artifact = (path: string, absolutePath: string): Artifact => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  kind: "screenshot",
  ticketKey: "T-1",
  absolutePath,
});

const SHOT = artifact("artifacts/T-1/after.png", "/work/.agentboard/artifacts/T-1/after.png");
const OTHER = artifact("artifacts/T-2/after.png", "/work/.agentboard/artifacts/T-2/after.png");

describe("what a link in a reply points at", () => {
  it("Given a GitHub pull request or issue URL, when it is classified, then it is a reference with a short label", () => {
    expect(classifyLink("https://github.com/acme/slugkit/pull/12")).toEqual({
      kind: "pull-request",
      label: "slugkit#12",
    });
    expect(classifyLink("https://github.com/acme/slugkit/issues/7")).toEqual({
      kind: "issue",
      label: "slugkit#7",
    });
  });

  it("Given a Linear issue URL, when it is classified, then it is an issue labeled with its key", () => {
    expect(classifyLink("https://linear.app/acme/issue/XEO-3330/slug")).toEqual({
      kind: "issue",
      label: "XEO-3330",
    });
  });

  it("Given a page, a path, and a fragment, when each is classified, then each gets its own kind", () => {
    expect(classifyLink("https://example.com/docs")).toEqual({ kind: "web" });
    expect(classifyLink("artifacts/T-1/after.png")).toEqual({
      kind: "file",
      path: "artifacts/T-1/after.png",
    });
    expect(classifyLink("#top")).toEqual({ kind: "anchor" });
    expect(classifyLink("mailto:a@b.co")).toEqual({ kind: "other" });
  });
});

describe("the artifact a path names", () => {
  it("Given the absolute path or the path under the store, when it is looked up, then the artifact is found", () => {
    expect(findArtifact("/work/.agentboard/artifacts/T-1/after.png", [SHOT, OTHER])).toBe(SHOT);
    expect(findArtifact("artifacts/T-2/after.png", [SHOT, OTHER])).toBe(OTHER);
  });

  it("Given a tail only one artifact ends with, when it is looked up, then that artifact is found", () => {
    expect(findArtifact("./T-1/after.png", [SHOT, OTHER])).toBe(SHOT);
  });

  it("Given a tail two artifacts end with, when it is looked up, then none is chosen", () => {
    expect(findArtifact("after.png", [SHOT, OTHER])).toBeNull();
  });
});
