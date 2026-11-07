import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  workspaceFileDownloadMimeType,
  workspaceFileDownloadResource,
} from "./workspaceFileDownload";

const threadId = ThreadId.make("thread-1");

describe("workspaceFileDownloadResource", () => {
  it("downloads a thread file through the host media resource", () => {
    expect(
      workspaceFileDownloadResource({
        cwd: "/repo",
        relativePath: "src/app.ts",
        threadId,
      }),
    ).toEqual({
      _tag: "media-file",
      threadId,
      path: "/repo/src/app.ts",
      disposition: "attachment",
    });
  });

  it("keeps a draft file inside its workspace", () => {
    expect(
      workspaceFileDownloadResource({
        cwd: "/repo",
        relativePath: "notes.txt",
        threadId: null,
      }),
    ).toEqual({
      _tag: "draft-workspace-file",
      cwd: "/repo",
      path: "notes.txt",
      disposition: "attachment",
    });
  });
});

describe("workspaceFileDownloadMimeType", () => {
  it.each([
    ["report.pdf", "application/pdf"],
    ["clip.mp4", "video/mp4"],
    ["archive.zip", "application/zip"],
    ["notes.ts", "application/octet-stream"],
    ["Dockerfile", "application/octet-stream"],
  ])("uses the share MIME type for %s", (name, mimeType) => {
    expect(workspaceFileDownloadMimeType(name)).toBe(mimeType);
  });
});
