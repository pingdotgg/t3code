import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildIssueTemplateBody,
  issueProjectSourceKey,
  issueSourceKey,
  IssueCreateInput,
  IssueDetail,
  IssueListInput,
  IssueListResult,
  IssueRef,
  IssueTemplateList,
  issueTemplateAnswersComplete,
  IssueUpdateInput,
  type IssueTemplateField,
} from "./issue.ts";

const decodeListResult = Schema.decodeUnknownSync(IssueListResult);
const decodeListInput = Schema.decodeUnknownSync(IssueListInput);
const decodeCreate = Schema.decodeUnknownSync(IssueCreateInput);
const decodeUpdate = Schema.decodeUnknownSync(IssueUpdateInput);
const decodeDetail = Schema.decodeUnknownSync(IssueDetail);
const decodeTemplates = Schema.decodeUnknownSync(IssueTemplateList);
const GITHUB_SOURCE = issueSourceKey("github", "github.com");
const GITLAB_SOURCE = issueSourceKey("gitlab", "gitlab.com");

const LIST_RESULT: IssueListResult = {
  viewers: { [GITHUB_SOURCE]: "bilal", [GITLAB_SOURCE]: "bilal.hassan" },
  providers: [
    {
      host: "github.com",
      kind: "github",
      searchesOnHost: true,
      projectCount: 1,
      configured: true,
      detail: null,
    },
    {
      host: "gitlab.com",
      kind: "gitlab",
      searchesOnHost: true,
      projectCount: 1,
      configured: false,
      detail: "glab is not installed.",
    },
  ],
  entries: [
    {
      provider: "github",
      host: "github.com",
      projectId: "project-1" as IssueListResult["entries"][number]["projectId"],
      projectTitle: "t3code",
      repository: "pingdotgg/t3code",
      number: 7,
      title: "The list does not refresh after a close",
      url: "https://github.com/pingdotgg/t3code/issues/7",
      author: { login: "octocat", name: null, avatarUrl: null },
      state: "open",
      stateReason: null,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      closedAt: null,
      assignees: [{ login: "hubot", name: "Hubot", avatarUrl: null }],
      labels: [{ name: "bug", color: "d73a4a" }],
      milestone: null,
      commentCount: 3,
    },
  ],
  errors: [],
  truncated: false,
  nextCursors: { "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|1|7" },
};

describe("IssueListResult", () => {
  /**
   * The RPC builds this codec at call time, so a shape it cannot lower — an open-keyed record with
   * an optional value, for one — fails as an interrupted request rather than as a schema error.
   * Building it here turns that into a test failure instead.
   */
  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(IssueListResult);

    const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(LIST_RESULT));

    expect(decoded).toStrictEqual(LIST_RESULT);
  });

  it("keys a viewer by adapter and host, so accounts never cross", () => {
    const enterprise = issueSourceKey("github", "github.acme.dev");
    const jira = issueSourceKey("jira", "github.com");
    const decoded = decodeListResult({
      ...LIST_RESULT,
      viewers: { [GITHUB_SOURCE]: "bilal", [enterprise]: "b.hassan", [jira]: "jira-user" },
    });

    expect(decoded.viewers[GITHUB_SOURCE]).toBe("bilal");
    expect(decoded.viewers[enterprise]).toBe("b.hassan");
    expect(decoded.viewers[jira]).toBe("jira-user");
  });

  it("keys a viewer by project source when one host has several accounts", () => {
    const projectId = "project-1" as IssueListResult["entries"][number]["projectId"];
    const linear = issueProjectSourceKey("linear", "linear.app", projectId);
    const github = issueProjectSourceKey("github", "github.com", projectId);

    expect(linear).not.toBe(github);
    expect(linear).toBe('["linear","linear.app","project-1"]');
  });

  it("keeps why an issue was closed, which is not the same as that it was closed", () => {
    const entry = { ...LIST_RESULT.entries[0], state: "closed", stateReason: "not-planned" };

    expect(decodeListResult({ ...LIST_RESULT, entries: [entry] }).entries[0]?.stateReason).toBe(
      "not-planned",
    );
  });

  it("accepts issues from adapters that are not source control providers", () => {
    const decoded = decodeListResult({
      ...LIST_RESULT,
      providers: [{ ...LIST_RESULT.providers[0], kind: "jira", host: "acme.atlassian.net" }],
      entries: [{ ...LIST_RESULT.entries[0], provider: "jira", host: "acme.atlassian.net" }],
    });

    expect(decoded.providers[0]?.kind).toBe("jira");
    expect(decoded.entries[0]?.provider).toBe("jira");
  });
});

describe("IssueRef", () => {
  it("keeps an optional provider to disambiguate equal repository names", () => {
    expect(
      Schema.decodeUnknownSync(IssueRef)({
        projectId: "project-1",
        repository: "ENG",
        number: 7,
        provider: "linear",
      }),
    ).toMatchObject({ provider: "linear" });
  });
});

describe("IssueListInput", () => {
  it("accepts GitHub-style sort choices", () => {
    const input = decodeListInput({
      state: "open",
      sort: "reactions-thumbs-up",
      order: "desc",
    });

    expect(input.sort).toBe("reactions-thumbs-up");
    expect(input.order).toBe("desc");
  });

  it("trims a search, so what is sent is what was typed", () => {
    expect(decodeListInput({ state: "open", query: "  refresh  " }).query).toBe("refresh");
  });

  it("bounds a search, because it travels into a command and a query string", () => {
    expect(decodeListInput({ state: "open", query: "p".repeat(200) }).query).toHaveLength(200);
    expect(() => decodeListInput({ state: "open", query: "p".repeat(201) })).toThrow();
  });

  it("takes back the continuation a result handed out, keyed the way it arrived", () => {
    const cursors = { "github.com pingdotgg/t3code": "2026-07-02T00:00:00Z|99|7,8" };

    expect(decodeListInput({ state: "open", cursors }).cursors).toStrictEqual(cursors);
  });

  it("bounds a continuation, because it comes back from the page and goes into a filter", () => {
    const long = (length: number) => ({ "github.com acme/web": "c".repeat(length) });
    expect(decodeListInput({ state: "open", cursors: long(4096) })).toBeDefined();
    expect(() => decodeListInput({ state: "open", cursors: long(4097) })).toThrow();
  });
});

describe("IssueCreateInput", () => {
  const base = { projectId: "p1", repository: "acme/web", title: "Crash on open", labels: [] };

  it("takes an issue with a title and nothing else, which is a legitimate one", () => {
    expect(decodeCreate({ ...base, body: "", assignees: [] }).body).toBe("");
  });

  it("refuses an issue with no title, which no host would file", () => {
    expect(() => decodeCreate({ ...base, title: "   ", body: "", assignees: [] })).toThrow();
  });

  it("bounds the labels and assignees, because they travel into a body the page composed", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => `entry${index}`);
    expect(decodeCreate({ ...base, body: "", assignees: many(25) }).assignees).toHaveLength(25);
    expect(() => decodeCreate({ ...base, body: "", assignees: many(26) })).toThrow();
    expect(() => decodeCreate({ ...base, labels: many(51), body: "", assignees: [] })).toThrow();
  });
});

describe("IssueUpdateInput", () => {
  const ref = { projectId: "p1", repository: "acme/web", number: 7 };

  it("carries only what was edited, so a rename does not resend a body nobody touched", () => {
    const decoded = decodeUpdate({ ...ref, title: "Crash on open" });

    expect(decoded.title).toBe("Crash on open");
    expect(decoded.body).toBeUndefined();
  });

  // Not trimmed: a body is markdown, where leading spaces open a code block and two trailing
  // spaces are a line break.
  it("leaves a body exactly as it was written", () => {
    expect(decodeUpdate({ ...ref, body: "    indented\n" }).body).toBe("    indented\n");
  });
});

describe("IssueDetail", () => {
  it("carries the change requests that reference it, marking the ones that close it", () => {
    const detail = decodeDetail({
      provider: "github",
      capabilities: {
        comment: true,
        actions: ["close", "reopen"],
        closeReasons: ["completed", "not-planned"],
        create: true,
        issueTemplates: true,
        edit: true,
        labels: true,
        assignees: true,
        listLabelCandidates: true,
        listAssigneeCandidates: true,
        search: true,
        linkedPullRequests: true,
        timelineEvents: true,
      },
      viewerPermissions: {
        actions: ["close"],
        comment: true,
        edit: true,
        labels: true,
        assignees: true,
        create: true,
      },
      projectId: "project-1",
      projectTitle: "t3code",
      workspaceRoot: "/home/bilal/t3code",
      repository: "pingdotgg/t3code",
      number: 7,
      title: "The list does not refresh after a close",
      body: "Steps to reproduce",
      url: "https://github.com/pingdotgg/t3code/issues/7",
      author: { login: "octocat", name: null, avatarUrl: null },
      state: "open",
      stateReason: null,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      closedAt: null,
      assignees: [],
      labels: [],
      milestone: null,
      commentCount: 0,
      linkedPullRequests: [
        {
          repository: "pingdotgg/t3code",
          number: 12,
          title: "Refresh the list after a close",
          url: "https://github.com/pingdotgg/t3code/pull/12",
          state: "open",
          isDraft: false,
          closesIssue: true,
        },
      ],
    });

    expect(detail.linkedPullRequests.map((entry) => entry.closesIssue)).toEqual([true]);
  });
});

describe("IssueTemplateList", () => {
  const TEMPLATES: IssueTemplateList = {
    capabilities: {
      comment: true,
      actions: ["close", "reopen"],
      closeReasons: ["completed", "not-planned"],
      create: true,
      issueTemplates: true,
      edit: true,
      labels: true,
      assignees: true,
      listLabelCandidates: true,
      listAssigneeCandidates: true,
      search: true,
      linkedPullRequests: true,
      timelineEvents: true,
    },
    templates: [
      {
        key: "bug_report.md",
        name: "Bug report",
        about: "Something is broken",
        title: "[Bug]: ",
        body: "### What happened\n\n",
        labels: ["bug"],
        assignees: ["octocat"],
      },
      // A GitLab template, which carries a body and nothing else.
      {
        key: "Default",
        name: "Default",
        about: "",
        title: "",
        body: "## Summary\n",
        labels: [],
        assignees: [],
      },
      // A GitHub issue form, which asks questions instead of supplying a draft.
      {
        key: "feature.yml",
        name: "Feature request",
        about: "Ask for something new",
        title: "[Feature]: ",
        body: "",
        fields: [
          { kind: "markdown", value: "Thanks for taking the time." },
          {
            kind: "input",
            id: "contact",
            label: "Contact",
            description: "How can we reach you",
            placeholder: "you@example.com",
            value: "",
            required: false,
          },
          {
            kind: "textarea",
            id: "logs",
            label: "Relevant log output",
            description: "",
            placeholder: "",
            value: "",
            render: "shell",
            required: false,
          },
          {
            kind: "dropdown",
            id: "area",
            label: "Area",
            description: "",
            options: ["Web", "Mobile"],
            multiple: true,
            required: true,
          },
          {
            kind: "checkboxes",
            id: "terms",
            label: "Before submitting",
            description: "",
            options: [{ label: "I searched the existing issues", required: true }],
          },
        ],
        labels: ["enhancement"],
        assignees: [],
      },
    ],
    contactLinks: [
      {
        name: "Ask a question",
        about: "Anything that is not a defect",
        url: "https://github.com/pingdotgg/t3code/discussions",
      },
    ],
    blankIssuesEnabled: false,
    contributingGuidelinesUrl: "https://github.com/pingdotgg/t3code/blob/HEAD/CONTRIBUTING.md",
  };

  it("round-trips through the JSON codec the RPC serializes with", () => {
    const codec = Schema.toCodecJson(IssueTemplateList);

    const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(TEMPLATES));

    expect(decoded).toStrictEqual(TEMPLATES);
  });

  // Not trimmed: a template body is markdown a repository wrote deliberately, headings, blank
  // lines and all, and the form it opens has to show exactly what the repository asks for.
  it("leaves a template body exactly as the repository wrote it", () => {
    const decoded = decodeTemplates({
      ...TEMPLATES,
      templates: [{ ...TEMPLATES.templates[0], body: "  indented\n\n" }],
    });

    expect(decoded.templates[0]?.body).toBe("  indented\n\n");
  });

  it("takes a repository that offers nothing, which is where the blank form comes from", () => {
    const decoded = decodeTemplates({
      capabilities: TEMPLATES.capabilities,
      templates: [],
      contactLinks: [],
      blankIssuesEnabled: true,
    });

    expect(decoded.templates).toEqual([]);
    expect(decoded.blankIssuesEnabled).toBe(true);
  });

  // A server from before capabilities travelled here still answers the offer, and a composer that
  // reads none is where it stood before: everything offered, and the host refuses what it cannot do.
  it("takes an offer from a server that says nothing about what the host can do", () => {
    const decoded = decodeTemplates({
      templates: [],
      contactLinks: [],
      blankIssuesEnabled: true,
    });

    expect(decoded.capabilities).toBeUndefined();
  });

  // A markdown template supplies no questions, which is how the composer tells the two apart.
  it("takes a template with a body and no fields at all", () => {
    const decoded = decodeTemplates({
      ...TEMPLATES,
      templates: [TEMPLATES.templates[1]],
    });

    expect(decoded.templates[0]?.fields).toBeUndefined();
  });
});

describe("buildIssueTemplateBody", () => {
  const FIELDS: ReadonlyArray<IssueTemplateField> = [
    { kind: "markdown", value: "Thanks for taking the time to fill this out." },
    {
      kind: "input",
      id: "version",
      label: "Version",
      description: "",
      placeholder: "1.2.3",
      value: "",
      required: true,
    },
    {
      kind: "input",
      id: "contact",
      label: "Contact details",
      description: "",
      placeholder: "",
      value: "",
      required: false,
    },
    {
      kind: "textarea",
      id: "what-happened",
      label: "What happened?",
      description: "",
      placeholder: "",
      value: "",
      render: null,
      required: true,
    },
    {
      kind: "textarea",
      id: "logs",
      label: "Relevant log output",
      description: "",
      placeholder: "",
      value: "",
      render: "shell",
      required: false,
    },
    {
      kind: "dropdown",
      id: "browsers",
      label: "Browsers",
      description: "",
      options: ["Firefox", "Chrome", "Safari"],
      multiple: true,
      required: false,
    },
    {
      kind: "checkboxes",
      id: "terms",
      label: "Before submitting",
      description: "",
      options: [
        { label: "I searched the existing issues", required: true },
        { label: "I can reproduce this on the latest release", required: false },
      ],
    },
  ];

  // The whole thing at once, because what matters is that an issue filed from here is byte for
  // byte what the same answers filed on the host would have produced.
  it("writes the markdown GitHub itself writes for a filled-in form", () => {
    const body = buildIssueTemplateBody(FIELDS, {
      version: "1.2.3",
      "what-happened": "The page never loads",
      logs: "Error: boom",
      browsers: ["Safari", "Firefox"],
      terms: ["I searched the existing issues"],
    });

    expect(body).toBe(
      [
        "### Version",
        "",
        "1.2.3",
        "",
        "### Contact details",
        "",
        "_No response_",
        "",
        "### What happened?",
        "",
        "The page never loads",
        "",
        "### Relevant log output",
        "",
        "```shell",
        "Error: boom",
        "```",
        "",
        "### Browsers",
        "",
        "Firefox, Safari",
        "",
        "### Before submitting",
        "",
        "- [x] I searched the existing issues",
        "- [ ] I can reproduce this on the latest release",
      ].join("\n"),
    );
  });

  // Prose the form shows is not a question, so it heads nothing and files nothing.
  it("leaves the prose out of the body entirely", () => {
    expect(buildIssueTemplateBody([FIELDS[0]!], {})).toBe("");
  });

  // An unanswered optional question has to stay visible: a maintainer reading the issue has to be
  // able to tell one that was skipped from one that was never asked.
  it("says so where every optional question was left alone", () => {
    const body = buildIssueTemplateBody(FIELDS, {});

    expect(body.split("_No response_").length - 1).toBe(5);
  });

  // A fence around nothing is worse than the sentence: it reads as an answer that was empty.
  it("leaves the fence off a rendered answer nobody wrote", () => {
    expect(buildIssueTemplateBody([FIELDS[4]!], { logs: "   " })).toBe(
      "### Relevant log output\n\n_No response_",
    );
  });

  // Four spaces are a code block, so an answer trimmed at the front is filed as prose the reader
  // never wrote. Only what follows the last word goes, which the blank line between blocks and the
  // closing fence would otherwise file as an empty line.
  it("files an indented answer with the indentation it was written with", () => {
    expect(buildIssueTemplateBody([FIELDS[3]!], { "what-happened": "    boom()\n\n" })).toBe(
      "### What happened?\n\n    boom()",
    );
    expect(buildIssueTemplateBody([FIELDS[4]!], { logs: "  Error: boom  \n" })).toBe(
      "### Relevant log output\n\n```shell\n  Error: boom\n```",
    );
  });

  it("files the options a dropdown offers in its own order, not the order they were taken", () => {
    expect(buildIssueTemplateBody([FIELDS[5]!], { browsers: ["Safari", "Chrome"] })).toBe(
      "### Browsers\n\nChrome, Safari",
    );
  });

  // One option taken is still an array to the assembler, and a single dropdown answers with one.
  it("takes a lone option written as a word rather than as a list", () => {
    expect(buildIssueTemplateBody([FIELDS[5]!], { browsers: "Chrome" })).toBe(
      "### Browsers\n\nChrome",
    );
  });
});

describe("issueTemplateAnswersComplete", () => {
  const REQUIRED: ReadonlyArray<IssueTemplateField> = [
    {
      kind: "input",
      id: "version",
      label: "Version",
      description: "",
      placeholder: "",
      value: "",
      required: true,
    },
    {
      kind: "dropdown",
      id: "area",
      label: "Area",
      description: "",
      options: ["Web", "Mobile"],
      multiple: false,
      required: true,
    },
    {
      kind: "checkboxes",
      id: "terms",
      label: "Before submitting",
      description: "",
      options: [
        { label: "I searched the existing issues", required: true },
        { label: "I am willing to submit a fix", required: false },
      ],
    },
  ];

  it("holds filing back until every question the form insists on is answered", () => {
    expect(issueTemplateAnswersComplete(REQUIRED, {})).toBe(false);
    expect(
      issueTemplateAnswersComplete(REQUIRED, { version: "  ", area: ["Web"], terms: [] }),
    ).toBe(false);
    expect(
      issueTemplateAnswersComplete(REQUIRED, {
        version: "1.2.3",
        area: ["Web"],
        terms: ["I searched the existing issues"],
      }),
    ).toBe(true);
  });

  // A box the form left free is not a question filing waits on, ticked or not.
  it("lets an optional box through unticked", () => {
    expect(
      issueTemplateAnswersComplete([REQUIRED[2]!], { terms: ["I searched the existing issues"] }),
    ).toBe(true);
  });
});
