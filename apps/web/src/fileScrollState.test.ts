import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  approximateSourceLineScrollTop,
  readHandledFileReveal,
  rememberHandledFileReveal,
  clearFileScrollStateForTests,
  fileScrollPositionKey,
  readFileScrollPosition,
  rememberFileScrollPosition,
  resolveRestoredFileScrollTop,
} from "./fileScrollState";

describe("file scroll state", () => {
  beforeEach(clearFileScrollStateForTests);

  it("scopes positions to the thread, workspace, and path", () => {
    expect(
      fileScrollPositionKey({
        threadKey: "environment:thread-a",
        cwd: "/workspace",
        relativePath: "README.md",
      }),
    ).not.toBe(
      fileScrollPositionKey({
        threadKey: "environment:thread-b",
        cwd: "/workspace",
        relativePath: "README.md",
      }),
    );
  });

  it("restores the exact offset when the surface geometry is unchanged", () => {
    rememberFileScrollPosition("thread:file", 640, 2_000, {
      surface: "source",
      anchorLine: 34,
    });

    expect(
      resolveRestoredFileScrollTop(readFileScrollPosition("thread:file"), 2_000, {
        surface: "source",
        anchorScrollTop: 900,
      }),
    ).toBe(640);
  });

  it("restores the same content anchor when Markdown and source layouts differ", () => {
    rememberFileScrollPosition("thread:README.md", 500, 2_000, {
      surface: "source",
      anchorLine: 32,
    });

    expect(
      resolveRestoredFileScrollTop(readFileScrollPosition("thread:README.md"), 4_000, {
        surface: "markdown",
        anchorScrollTop: 720,
      }),
    ).toBe(720);
  });

  it("falls back to document progress until the content anchor is rendered", () => {
    rememberFileScrollPosition("thread:README.md", 500, 2_000, {
      surface: "source",
      anchorLine: 32,
    });

    expect(
      resolveRestoredFileScrollTop(readFileScrollPosition("thread:README.md"), 4_000, {
        surface: "markdown",
        anchorScrollTop: null,
      }),
    ).toBe(1_000);
  });

  it("approximates an unrendered source anchor by line while the virtualizer catches up", () => {
    expect(approximateSourceLineScrollTop(51, 101, 2_000)).toBe(1_000);
  });

  it("remembers which reveal request a file already consumed across panel mounts", () => {
    expect(readHandledFileReveal("thread:README.md")).toBeNull();
    rememberHandledFileReveal("thread:README.md", 7);
    expect(readHandledFileReveal("thread:README.md")).toBe(7);
    expect(readHandledFileReveal("thread:OTHER.md")).toBeNull();
  });
});
