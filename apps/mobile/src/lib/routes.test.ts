import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  buildGitConfirmNavigation,
  buildThreadFilesNavigation,
  buildThreadFilesRoutePath,
  buildThreadReviewCommentNavigation,
  newTaskDraftNavigation,
  threadNavigation,
} from "./routes";

const thread = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("thread file routes", () => {
  it("includes an optional source line in string routes", () => {
    expect(buildThreadFilesRoutePath(thread, "src/main.ts", 42)).toBe(
      "/threads/environment-1/thread-1/files/src/main.ts?line=42",
    );
  });

  it("encodes each file path segment without encoding separators", () => {
    expect(buildThreadFilesRoutePath(thread, "docs/My File#1.md")).toBe(
      "/threads/environment-1/thread-1/files/docs/My%20File%231.md",
    );
  });

  it("builds typed navigation params for a file and source line", () => {
    expect(buildThreadFilesNavigation(thread, "src/main.ts", 42)).toEqual({
      name: "ThreadFile",
      params: {
        environmentId: "environment-1",
        threadId: "thread-1",
        path: ["src", "main.ts"],
        line: "42",
      },
    });
  });

  it("targets the files index when no file path is provided", () => {
    expect(buildThreadFilesNavigation(thread)).toEqual({
      name: "ThreadFiles",
      params: {
        environmentId: "environment-1",
        threadId: "thread-1",
      },
    });
  });
});

describe("named navigation targets", () => {
  it("builds thread params without string route templates", () => {
    expect(threadNavigation(thread)).toEqual({
      name: "Thread",
      params: {
        environmentId: "environment-1",
        threadId: "thread-1",
      },
    });
  });

  it("builds review comment params without string route templates", () => {
    expect(buildThreadReviewCommentNavigation(thread)).toEqual({
      name: "ThreadReviewComment",
      params: {
        environmentId: "environment-1",
        threadId: "thread-1",
      },
    });
  });

  it("builds git confirmation params with action metadata", () => {
    expect(
      buildGitConfirmNavigation(thread, {
        branchName: "main",
        confirmAction: "push",
        includesCommit: "false",
      }),
    ).toEqual({
      name: "GitConfirm",
      params: {
        environmentId: "environment-1",
        threadId: "thread-1",
        branchName: "main",
        confirmAction: "push",
        includesCommit: "false",
      },
    });
  });

  it("builds new task draft params in one place", () => {
    expect(
      newTaskDraftNavigation({
        environmentId: "environment-1",
        projectId: "project-1",
        title: "Project",
      }),
    ).toEqual({
      name: "NewTaskDraft",
      params: {
        environmentId: "environment-1",
        projectId: "project-1",
        title: "Project",
      },
    });
  });
});
