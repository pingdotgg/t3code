import { describe, expect, it } from "vite-plus/test";

import { issueCreateBlocked, resolveIssueType } from "./IssueCreateDialog.logic";

const bug = { id: "10001", name: "Bug" };
const task = { id: "10002", name: "Task" };

describe("resolveIssueType", () => {
  it("picks the only type without asking", () => {
    expect(resolveIssueType([bug], null)).toBe("10001");
  });

  it("needs an explicit choice among several, and drops a stale one", () => {
    expect(resolveIssueType([bug, task], null)).toBeNull();
    expect(resolveIssueType([bug, task], "10002")).toBe("10002");
    expect(resolveIssueType([bug, task], "999")).toBeNull();
  });
});

describe("issueCreateBlocked", () => {
  const ready = {
    hasScope: true,
    canWrite: true,
    templates: null,
    blankChosen: true,
    issueTypes: null,
  } as const;

  it("lets a blank issue through when nothing forbids it", () => {
    expect(issueCreateBlocked(ready)).toBeNull();
    expect(
      issueCreateBlocked({
        ...ready,
        templates: { pending: false, list: null },
      }),
    ).toBeNull();
  });

  it("waits for the template config before allowing a blank issue", () => {
    expect(issueCreateBlocked({ ...ready, templates: { pending: true, list: null } })).toBe(
      "Loading templates…",
    );
  });

  it("blocks a blank issue the tracker forbids, even with no template on offer", () => {
    const forbidding = (count: number) => ({
      ...ready,
      templates: {
        pending: false,
        list: { blankIssuesEnabled: false, templates: Array.from({ length: count }) },
      },
    });
    expect(issueCreateBlocked(forbidding(2))).toBe("This tracker requires a template.");
    expect(issueCreateBlocked(forbidding(0))).toBe(
      "This tracker requires a template, and none can be filled in here.",
    );
    expect(issueCreateBlocked({ ...forbidding(2), blankChosen: false })).toBeNull();
  });

  it("requires a resolvable issue type where the tracker files by type", () => {
    const typed = (issueTypes: {
      pending: boolean;
      error: string | null;
      count: number;
      chosen: string | null;
    }) => issueCreateBlocked({ ...ready, issueTypes });
    expect(typed({ pending: true, error: null, count: 0, chosen: null })).toBe(
      "Loading issue types…",
    );
    expect(
      typed({ pending: false, error: "Jira could not be reached.", count: 0, chosen: null }),
    ).toBe("Issue types could not be read: Jira could not be reached.");
    expect(typed({ pending: false, error: null, count: 0, chosen: null })).toBe(
      "This project offers no issue types.",
    );
    expect(typed({ pending: false, error: null, count: 2, chosen: null })).toBe(
      "Choose an issue type.",
    );
    expect(typed({ pending: false, error: null, count: 2, chosen: "10001" })).toBeNull();
  });

  it("puts a missing scope or write permission first", () => {
    expect(issueCreateBlocked({ ...ready, hasScope: false })).toBe(
      "No project here can file issues.",
    );
    expect(issueCreateBlocked({ ...ready, canWrite: false })).toBe(
      "Creating issues needs the source-control write scope.",
    );
  });
});
