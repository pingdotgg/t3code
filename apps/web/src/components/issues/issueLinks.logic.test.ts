import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "@t3tools/contracts";

import {
  issueLinkChangesMatch,
  issueStartPrompt,
  parseIssueReferenceInput,
  resolveIssuePanelEnvironment,
  resolveIssueProject,
  startThreadFromIssue,
} from "./issueLinks.logic";

const identity = (canonicalKey: string, provider = "github") => ({
  repositoryIdentity: { canonicalKey, provider },
});

describe("parseIssueReferenceInput", () => {
  it("reads URLs, qualified and bare numbers", () => {
    expect(parseIssueReferenceInput(" https://github.com/acme/web/issues/12 ")).toEqual({
      url: "https://github.com/acme/web/issues/12",
    });
    expect(parseIssueReferenceInput("acme/web#12")).toEqual({ repository: "acme/web", number: 12 });
    expect(parseIssueReferenceInput("#12")).toEqual({ number: 12 });
    expect(parseIssueReferenceInput("12")).toEqual({ number: 12 });
  });

  it("rejects pull request URLs and noise", () => {
    expect(parseIssueReferenceInput("https://github.com/acme/web/pull/12")).toBeNull();
    expect(parseIssueReferenceInput("#0")).toBeNull();
    expect(parseIssueReferenceInput("twelve")).toBeNull();
    expect(parseIssueReferenceInput("")).toBeNull();
  });
});

describe("issueStartPrompt", () => {
  const issue = {
    host: "github.com",
    repository: "acme/web",
    number: 12,
    title: " Fix login ",
    url: "https://github.com/acme/web/issues/12",
  };
  it("is just the URL when only the link is known", () => {
    expect(issueStartPrompt({ ...issue, title: null, body: null })).toBe(
      "https://github.com/acme/web/issues/12",
    );
  });
  it("puts the title, URL and body in that order", () => {
    expect(issueStartPrompt({ ...issue, body: "Steps\n1. log in\n" })).toBe(
      "Fix login\n\nhttps://github.com/acme/web/issues/12\n\nSteps\n1. log in",
    );
  });
  it("leaves out an empty body", () => {
    expect(issueStartPrompt({ ...issue, body: "  " })).toBe(
      "Fix login\n\nhttps://github.com/acme/web/issues/12",
    );
  });
});

describe("resolveIssueProject", () => {
  const issue = { host: "github.com", repository: "Acme/Web", number: 1 };
  it("picks the first GitHub checkout of the Issue's repository", () => {
    const projects = [
      { id: "gitlab", ...identity("github.com/acme/web", "gitlab") },
      { id: "other", ...identity("github.com/acme/api") },
      { id: "web", ...identity("github.com/acme/web") },
      { id: "web-2", ...identity("github.com/acme/web") },
    ];
    expect(resolveIssueProject(projects, issue)).toEqual({ project: projects[2] });
  });
  it("prefers a checkout on a server that keeps Issue links", () => {
    const projects = [
      { id: "old-server", environmentId: "old", ...identity("github.com/acme/web") },
      { id: "links-server", environmentId: "new", ...identity("github.com/acme/web") },
    ];
    const keepsLinks = (project: { environmentId: string }) => project.environmentId === "new";
    expect(resolveIssueProject(projects, issue, keepsLinks)).toEqual({ project: projects[1] });
    // With no such server, the first checkout still starts the thread.
    expect(resolveIssueProject(projects, issue, () => false)).toEqual({ project: projects[0] });
  });
  it("explains why no project can start a thread", () => {
    expect(resolveIssueProject([{ repositoryIdentity: null }], issue)).toEqual({
      reason: "No project is a checkout of Acme/Web. Add one to start a thread.",
    });
  });
});

describe("startThreadFromIssue", () => {
  const issue = {
    host: "github.com",
    repository: "acme/web",
    number: 7,
    url: "https://github.com/acme/web/issues/7",
    title: "Crash on save",
    body: "Stack trace",
  };
  const projects = [
    { id: "api", ...identity("github.com/acme/api") },
    { id: "web", ...identity("github.com/acme/web") },
  ];

  it("opens a draft in the matching project, prefills it and links its thread", async () => {
    const steps: string[] = [];
    const opened = await startThreadFromIssue(issue, {
      projects,
      openDraft: async (project) => {
        steps.push(`open ${project.id}`);
        return { draftId: "draft-1", threadId: "thread-1" };
      },
      writePrompt: (draftId, prompt) => steps.push(`prompt ${draftId} ${JSON.stringify(prompt)}`),
      link: async (project, threadId, url) => steps.push(`link ${project.id} ${threadId} ${url}`),
    });
    expect(opened).toEqual({ draftId: "draft-1", threadId: "thread-1" });
    expect(steps).toEqual([
      "open web",
      `prompt draft-1 ${JSON.stringify("Crash on save\n\nhttps://github.com/acme/web/issues/7\n\nStack trace")}`,
      "link web thread-1 https://github.com/acme/web/issues/7",
    ]);
  });

  it("does nothing without a matching project or when no draft opens", async () => {
    const steps: string[] = [];
    const record = {
      writePrompt: () => steps.push("prompt"),
      link: async () => steps.push("link"),
    };
    expect(
      await startThreadFromIssue(issue, {
        projects: [projects[0]!],
        openDraft: async () => ({ draftId: "d", threadId: "t" }),
        ...record,
      }),
    ).toBeNull();
    expect(
      await startThreadFromIssue(issue, { projects, openDraft: async () => null, ...record }),
    ).toBeNull();
    expect(steps).toEqual([]);
  });
});

describe("issueLinkChangesMatch", () => {
  const change = (threadId: string, number: number) => ({
    threadId: ThreadId.make(threadId),
    issues: [{ host: "github.com", repository: "acme/web", number }],
  });
  it("matches when any change in a batch delivered together names the target", () => {
    const batch = [change("thread-a", 1), change("thread-b", 2)];
    expect(issueLinkChangesMatch(batch, { threadId: "thread-b", issues: [] })).toBe(true);
    expect(
      issueLinkChangesMatch(batch, { threadId: null, issues: ["github.com/acme/web#2"] }),
    ).toBe(true);
    expect(
      issueLinkChangesMatch(batch, { threadId: "thread-c", issues: ["github.com/acme/web#3"] }),
    ).toBe(false);
  });
});

describe("resolveIssuePanelEnvironment", () => {
  const issue = { host: "github.com", repository: "acme/web", number: 1 };
  const projects = [
    { environmentId: "upstream" as EnvironmentId, ...identity("github.com/acme/web") },
    { environmentId: "issues-only" as EnvironmentId, ...identity("github.com/acme/web") },
    { environmentId: "fork" as EnvironmentId, ...identity("github.com/acme/web") },
  ];
  const servers = {
    issues: ["issues-only", "fork"] as EnvironmentId[],
    issueLinks: ["fork"] as EnvironmentId[],
  };

  it("keeps the server the link names when it lists Issues", () => {
    expect(
      resolveIssuePanelEnvironment(issue, "issues-only" as EnvironmentId, projects, servers),
    ).toBe("issues-only");
  });

  it("never reads through a server without Issues, preferring one with Issue links", () => {
    expect(
      resolveIssuePanelEnvironment(issue, "upstream" as EnvironmentId, projects, servers),
    ).toBe("fork");
    expect(resolveIssuePanelEnvironment(issue, undefined, projects, servers)).toBe("fork");
    expect(
      resolveIssuePanelEnvironment(issue, undefined, projects, { issues: [], issueLinks: [] }),
    ).toBeNull();
  });
});
