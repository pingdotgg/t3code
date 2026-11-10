import { describe, expect, it } from "vite-plus/test";

import { artifactTreeEntries } from "./artifactTreeEntries";

describe("artifactTreeEntries", () => {
  it("keeps unique tree paths when basenames collide", () => {
    const entries = artifactTreeEntries([
      {
        id: "temp-file:/tmp/a/report.html",
        kind: "temp-file",
        title: "report.html",
        url: null,
        path: "/tmp/a/report.html",
        htmlRender: null,
        toolName: null,
        itemId: "1",
      },
      {
        id: "temp-file:/tmp/b/report.html",
        kind: "temp-file",
        title: "report.html",
        url: null,
        path: "/tmp/b/report.html",
        htmlRender: null,
        toolName: null,
        itemId: "2",
      },
      {
        id: "html-render:att-1",
        kind: "html-render",
        title: "report",
        url: null,
        path: null,
        htmlRender: { attachmentId: "att-1", title: "report", height: 100 },
        toolName: null,
        itemId: "3",
      },
    ]);

    expect(entries.map((entry) => entry.path)).toEqual([
      "report.html",
      "report (2).html",
      "report (3).html",
    ]);
    expect(entries.map((entry) => entry.artifact.id)).toEqual([
      "temp-file:/tmp/a/report.html",
      "temp-file:/tmp/b/report.html",
      "html-render:att-1",
    ]);
  });
});
