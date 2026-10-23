import { describe, expect, it } from "vite-plus/test";
import {
  appendPullRequestAgentPrompt,
  pullRequestAgentPrompt,
  pullRequestAgentThread,
} from "./pullRequestAgentTasks";
import { IsoDateTime, ProjectId, ThreadId } from "@t3tools/contracts";

describe("PR agent tasks", () => {
  it("continues a single linked thread, but keeps an explicit new-thread choice separate", () => {
    const thread = {
      id: ThreadId.make("thread-one"),
      projectId: ProjectId.make("project-one"),
      title: "Existing work",
      archivedAt: null,
    };
    expect(pullRequestAgentThread([thread])).toBe(thread);
    expect(pullRequestAgentThread([thread], "new")).toBeUndefined();
    expect(pullRequestAgentThread([thread], "missing")).toBeUndefined();
    expect(pullRequestAgentThread([])).toBeUndefined();
    const archived = {
      ...thread,
      id: ThreadId.make("thread-two"),
      archivedAt: IsoDateTime.make("2026-10-09T10:00:00.000Z"),
    };
    expect(pullRequestAgentThread([thread, archived])).toBeUndefined();
    expect(pullRequestAgentThread([thread, archived], archived.id)).toBe(archived);
  });
  it("replaces the helper's own text when switching tasks, keeping user edits", () => {
    const first = appendPullRequestAgentPrompt("My question", "explain");
    const next = appendPullRequestAgentPrompt(first, "feedback", pullRequestAgentPrompt("explain"));
    expect(next).toBe(`My question\n\n${pullRequestAgentPrompt("feedback")}`);
    expect(appendPullRequestAgentPrompt(next, "ask", pullRequestAgentPrompt("feedback"))).toBe(
      "My question",
    );
    const edited = `${first} with my own edit`;
    expect(appendPullRequestAgentPrompt(edited, "ask", pullRequestAgentPrompt("explain"))).toBe(
      edited,
    );
  });
});
