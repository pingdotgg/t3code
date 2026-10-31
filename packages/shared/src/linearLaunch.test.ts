import {
  LinearIssueContextRecord,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectId,
  type LinearIssue,
  type LinearIssueDetail,
  type LinearMapping,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { projectComposerContextForProvider } from "./composerContextReferences.ts";
import {
  buildLinearIssueContextRecord,
  buildLinearIssueMarkdown,
  buildLinearIssuePrompt,
  formatTokenEstimate,
  linearIssueIncludeCounts,
  resolveLinearMapping,
  resolveLinearMoveTarget,
} from "./linearLaunch.ts";

const isContextRecord = Schema.is(LinearIssueContextRecord);

const makeIssue = (overrides: Partial<LinearIssue> = {}): LinearIssue =>
  ({
    id: "issue-1",
    identifier: "ATT-612",
    title: "Server-side RFID APDU handshake",
    url: "https://linear.app/acme/issue/ATT-612",
    state: { id: "s1", name: "Todo", type: "unstarted", color: "#999" },
    priority: 2,
    priorityLabel: "High",
    assignee: { id: "u1", name: "Jan", avatarUrl: null },
    labels: [{ id: "l1", name: "backend", color: "#00f" }],
    cycle: null,
    milestone: { id: "m1", name: "Pilot" },
    project: { id: "p1", name: "RFID Gateway" },
    team: { id: "t1", key: "ATT", name: "Attraccess" },
    parent: null,
    subIssueCount: 0,
    completedSubIssueCount: 0,
    branchName: "jan/att-612-rfid",
    updatedAt: "2026-01-01T00:00:00.000Z",
    linkedPullRequests: [],
    ...overrides,
  }) as LinearIssue;

const makeDetail = (overrides: Partial<LinearIssueDetail> = {}): LinearIssueDetail => ({
  issue: makeIssue(),
  description: "Move the auth out of the reader.",
  milestoneProgress: 0.4,
  subIssues: [
    makeIssue({
      id: "s-1",
      identifier: "ATT-613",
      title: "Define schema",
      state: { id: "d", name: "Done", type: "completed", color: "#0f0" },
    }),
    makeIssue({ id: "s-2", identifier: "ATT-614", title: "Port auth" }),
  ],
  subIssuesFailed: false,
  comments: [
    {
      id: "c1",
      author: { id: "u2", name: "Sam", avatarUrl: null },
      body: "Use the recorded traces.",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ],
  attachments: [],
  ...overrides,
});

const mapping = (overrides: Partial<LinearMapping>): LinearMapping => ({
  id: "m",
  kind: "team",
  linearId: "t1",
  linearName: "Attraccess",
  projectId: ProjectId.make("proj-team"),
  ...overrides,
});

describe("resolveLinearMapping", () => {
  const issue = makeIssue();
  it("returns null when nothing is mapped", () => {
    expect(resolveLinearMapping(issue, [])).toBeNull();
    expect(resolveLinearMapping(issue, [mapping({ linearId: "other" })])).toBeNull();
  });

  it("falls back to the team mapping", () => {
    expect(resolveLinearMapping(issue, [mapping({ baseBranch: "main" })])).toEqual({
      projectRef: "proj-team",
      baseBranch: "main",
      source: "team",
      mappingId: "m",
    });
  });

  it("prefers the project mapping over the team mapping", () => {
    const result = resolveLinearMapping(issue, [
      mapping({}),
      mapping({
        id: "pm",
        kind: "project",
        linearId: "p1",
        projectId: ProjectId.make("proj-p"),
        baseBranch: "develop",
      }),
    ]);
    expect(result).toMatchObject({
      projectRef: "proj-p",
      baseBranch: "develop",
      source: "project",
    });
  });

  it("does not match a project mapping against a team id", () => {
    expect(resolveLinearMapping(issue, [mapping({ kind: "project", linearId: "t1" })])).toBeNull();
  });

  it("ignores project mappings for issues without a project", () => {
    const result = resolveLinearMapping(makeIssue({ project: null }), [
      mapping({ kind: "project", linearId: "p1" }),
    ]);
    expect(result).toBeNull();
  });

  it("reports a missing base branch as null", () => {
    expect(resolveLinearMapping(issue, [mapping({})])?.baseBranch).toBeNull();
  });
});

describe("buildLinearIssuePrompt", () => {
  it("names the issue and tells the agent to read the attachment", () => {
    expect(buildLinearIssuePrompt({ identifier: "ATT-612", title: "Handshake" })).toBe(
      "Implement ATT-612: Handshake.\n\nRead the attached issue, its sub-issues and comments first.\n\nWhen done, open a PR. Keep the branch name so Linear links it.",
    );
  });
});

describe("formatTokenEstimate", () => {
  it("estimates roughly four characters per token, in thousands with one decimal", () => {
    expect(formatTokenEstimate(0)).toBe("~0 tokens");
    expect(formatTokenEstimate(5)).toBe("~2 tokens");
    expect(formatTokenEstimate(400)).toBe("~100 tokens");
    expect(formatTokenEstimate(7_600)).toBe("~1.9k tokens");
  });
});

describe("buildLinearIssueContextRecord", () => {
  it("produces a valid record keyed by the issue", () => {
    const record = buildLinearIssueContextRecord(makeDetail());
    expect(isContextRecord(record)).toBe(true);
    expect(record.contextId).toBe("linear-issue_issue-1");
    expect(record.label).toBe("ATT-612 · Server-side RFID APDU handshake");
    expect(record.subIssues).toEqual([
      { identifier: "ATT-613", title: "Define schema", stateType: "completed" },
      { identifier: "ATT-614", title: "Port auth", stateType: "unstarted" },
    ]);
  });

  it("respects include toggles", () => {
    const record = buildLinearIssueContextRecord(
      makeDetail({
        issue: makeIssue({
          linkedPullRequests: [
            {
              repository: "acme/app",
              number: 7,
              state: "open",
              url: "https://github.com/acme/app/pull/7",
            },
          ],
        }),
      }),
      { subIssues: false, comments: false, linkedPrs: true },
    );
    expect(record.subIssues).toEqual([]);
    expect(record.comments).toEqual([]);
    expect(record.linkedPullRequests).toEqual([
      "acme/app#7 (open) https://github.com/acme/app/pull/7",
    ]);
  });

  it("applies the limits from the spec", () => {
    const detail = makeDetail({
      description: "d".repeat(20_000),
      subIssues: Array.from({ length: 60 }, (_, i) =>
        makeIssue({ id: `s${i}`, identifier: `ATT-${i}` }),
      ),
      comments: Array.from({ length: 20 }, (_, i) => ({
        id: `c${i}`,
        author: null,
        body: `${i}`.padEnd(3_000, "x"),
        createdAt: "2026-01-02T00:00:00.000Z",
      })),
    });
    const record = buildLinearIssueContextRecord(detail);
    expect(record.description.length).toBe(16_000);
    expect(record.description.endsWith("[description truncated]")).toBe(true);
    expect(record.subIssues).toHaveLength(50);
    expect(record.comments).toHaveLength(10);
    // Newest ten, oldest to newest.
    expect(record.comments[0]?.body.startsWith("10")).toBe(true);
    expect(record.comments[9]?.body.startsWith("19")).toBe(true);
    expect(record.comments.every((comment) => comment.body.length === 2_000)).toBe(true);
    expect(isContextRecord(record)).toBe(true);
  });
});

describe("linearIssueIncludeCounts", () => {
  it("counts what the limits would keep", () => {
    expect(linearIssueIncludeCounts(makeDetail())).toEqual({
      subIssues: 2,
      comments: 1,
      linkedPrs: 0,
    });
    expect(
      linearIssueIncludeCounts(
        makeDetail({ subIssues: Array.from({ length: 80 }, (_, i) => makeIssue({ id: `s${i}` })) }),
      ).subIssues,
    ).toBe(50);
  });
});

describe("buildLinearIssueMarkdown", () => {
  const all = { subIssues: true, comments: true, linkedPrs: true };
  const withPullRequest = makeDetail({
    issue: makeIssue({
      linkedPullRequests: [
        {
          repository: "acme/app",
          number: 7,
          state: "open",
          url: "https://github.com/acme/app/pull/7",
        },
      ],
    }),
  });

  it("renders heading, meta, description, sub-issues and comments", () => {
    const markdown = buildLinearIssueMarkdown(makeDetail(), all);
    expect(markdown).toContain("# ATT-612 · Server-side RFID APDU handshake");
    expect(markdown).toContain("Attraccess · RFID Gateway · Pilot · High · Todo");
    expect(markdown).toContain("\n- Branch: jan/att-612-rfid");
    expect(markdown).toContain("Move the auth out of the reader.");
    expect(markdown).toContain("- [x] ATT-613 Define schema");
    expect(markdown).toContain("- [ ] ATT-614 Port auth");
    expect(markdown).toContain("**Sam** · 2026-01-02T00:00:00.000Z");
    expect(markdown).not.toContain("Linked pull requests");
    expect(buildLinearIssueMarkdown(withPullRequest, all)).toContain(
      "## Linked pull requests\n\n- acme/app#7 (open) https://github.com/acme/app/pull/7",
    );
  });

  it("leaves out sections that are switched off", () => {
    const markdown = buildLinearIssueMarkdown(withPullRequest, {
      subIssues: false,
      comments: false,
      linkedPrs: false,
    });
    expect(markdown).not.toContain("## Sub-issues");
    expect(markdown).not.toContain("## Comments");
    expect(markdown).not.toContain("## Linked pull requests");
  });

  it("truncates to the provider input limit with a note", () => {
    const detail = makeDetail({
      subIssues: Array.from({ length: 50 }, (_, i) =>
        makeIssue({ id: `s${i}`, title: "t".repeat(2_000) }),
      ),
      comments: Array.from({ length: 10 }, (_, i) => ({
        id: `c${i}`,
        author: null,
        body: "c".repeat(2_000),
        createdAt: "x",
      })),
      description: "d".repeat(16_000),
    });
    const markdown = buildLinearIssueMarkdown(detail, all);
    expect(markdown.length).toBe(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(markdown.endsWith("exceeds the input size limit.]")).toBe(true);
  });
});

describe("agent-visible context payload", () => {
  it("renders the snapshot into the provider envelope", () => {
    const record = buildLinearIssueContextRecord(makeDetail());
    const text = `Go [${record.label}](t3-context://v1/linear-issue/${record.contextId})`;
    const projected = projectComposerContextForProvider({ text, records: [record] });
    expect(projected).toContain('kind="linear-issue"');
    expect(projected).toContain("# ATT-612 · Server-side RFID APDU handshake");
    expect(projected).toContain("Define schema");
  });
});

describe("state moves", () => {
  const states = [
    { id: "a", name: "Todo", type: "unstarted", position: 1 },
    { id: "c", name: "In Review", type: "started", position: 4 },
    { id: "b", name: "In Progress", type: "started", position: 2 },
    { id: "d", name: "Done", type: "completed", position: 5 },
  ] as const;

  it("defaults to the team's first started state", () => {
    expect(
      resolveLinearMoveTarget({
        currentStateType: "unstarted",
        teamStates: states,
        preferredStateId: null,
      }),
    ).toEqual({ id: "b", name: "In Progress" });
  });

  it("uses the configured state when the team has it, else falls back", () => {
    expect(
      resolveLinearMoveTarget({
        currentStateType: "backlog",
        teamStates: states,
        preferredStateId: "c",
      }),
    ).toEqual({ id: "c", name: "In Review" });
    expect(
      resolveLinearMoveTarget({
        currentStateType: "backlog",
        teamStates: states,
        preferredStateId: "other-team",
      }),
    ).toEqual({ id: "b", name: "In Progress" });
  });

  it("returns null for ineligible issues and teams without a started state", () => {
    expect(
      resolveLinearMoveTarget({
        currentStateType: "started",
        teamStates: states,
        preferredStateId: null,
      }),
    ).toBeNull();
    expect(
      resolveLinearMoveTarget({
        currentStateType: "backlog",
        teamStates: [states[0]],
        preferredStateId: null,
      }),
    ).toBeNull();
  });
});
