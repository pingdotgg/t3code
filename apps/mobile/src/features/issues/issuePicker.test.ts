import { describe, expect, it, vi } from "vite-plus/test";
import { IssueTrackerKind, ProjectId, type IssueDetail } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import {
  clearAcknowledgedIssuePicker,
  heldIssuePicker,
  issueLabelId,
  issuePickerConfirmed,
  issuePickerIds,
  issuePickerKey,
  issuePickerPending,
  nextIssuePickerIds,
  writeIssuePicker,
  type IssuePickerConfirmed,
} from "./issuePicker";

const environmentId = "environment";

function detail(patch: Partial<IssueDetail> = {}): IssueDetail {
  return {
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "org/repo",
    key: "1",
    displayKey: "#1",
    projectId: ProjectId.make("project"),
    projectTitle: "Project",
    title: "Issue",
    url: "https://example.com/issue",
    author: null,
    state: { category: "open", name: "Open" },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [{ name: "bug", color: null }],
    commentCount: 0,
    writable: true,
    viewer: "viewer",
    body: "",
    comments: [],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: true,
      states: [],
      closeReasons: [],
    },
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
    ...patch,
  };
}

/** One pick as the screen runs it: compute from what it holds, then hold what the tracker confirmed. */
function pick(
  issue: IssueDetail,
  kind: "labels" | "assignees",
  confirmed: IssuePickerConfirmed | null,
  id: string,
) {
  return {
    base: issue,
    environmentId,
    kind,
    ids: nextIssuePickerIds(issue, kind, confirmed, id, environmentId),
  };
}

describe("issue picker writes while the detail refresh is still on its way", () => {
  it("keeps the first label when a second is picked before the refreshed detail arrives", () => {
    const stale = detail();
    const first = pick(stale, "labels", null, "ui");
    expect(first.ids).toEqual(["bug", "ui"]);
    const second = pick(stale, "labels", first, "docs");
    expect(second.ids).toEqual(["bug", "ui", "docs"]);
    expect(issuePickerIds(stale, "labels", second, environmentId)).toEqual(["bug", "ui", "docs"]);
  });

  it("keeps the second confirmed label set when the first response arrives during the second write", async () => {
    let issue = detail();
    let confirmed: IssuePickerConfirmed | null = pick(issue, "labels", null, "ui");
    const base = issue;
    const docs = nextIssuePickerIds(issue, "labels", confirmed, "docs", environmentId);
    const write = Promise.withResolvers<void>();
    const success = write.promise.then(() => {
      confirmed = { base, ids: docs, environmentId, kind: "labels" };
    });
    issue = detail({
      labels: [
        { name: "bug", color: null },
        { name: "ui", color: null },
      ],
    });
    write.resolve();
    await success;
    expect(nextIssuePickerIds(issue, "labels", confirmed, "test", environmentId)).toEqual([
      "bug",
      "ui",
      "docs",
      "test",
    ]);
    expect(issuePickerIds(issue, "labels", confirmed, environmentId)).toEqual([
      "bug",
      "ui",
      "docs",
    ]);
    expect(nextIssuePickerIds(issue, "labels", confirmed, "docs", environmentId)).toEqual([
      "bug",
      "ui",
    ]);
  });

  it("removes and clears against the held set, and yields to the refreshed detail once it lands", () => {
    const stale = detail();
    const added = pick(stale, "labels", null, "ui");
    const removed = pick(stale, "labels", added, "bug");
    expect(removed.ids).toEqual(["ui"]);
    expect(pick(stale, "labels", removed, "ui").ids).toEqual([]);
    const refreshed = detail({ labels: [{ name: "ui", color: "ff0000" }] });
    expect(issuePickerIds(refreshed, "labels", removed, environmentId)).toEqual(["ui"]);
    expect(pick(refreshed, "labels", removed, "docs").ids).toEqual(["ui", "docs"]);
  });

  it("toggles labels by exact name and assignee ids without case", () => {
    const issue = detail({
      labels: [{ name: "Bug", color: null }],
      assignees: [{ id: "native-uuid", login: "viewer", name: null, avatarUrl: null }],
    });
    expect(nextIssuePickerIds(issue, "labels", null, "bug", environmentId)).toEqual(["Bug", "bug"]);
    expect(nextIssuePickerIds(issue, "labels", null, "Bug", environmentId)).toEqual([]);
    expect(nextIssuePickerIds(issue, "assignees", null, "NATIVE-UUID", environmentId)).toEqual([]);
  });

  it("keeps workspace and team labels with the same name separate when adding and removing by native id", () => {
    const workspace = { id: "BugW", name: "Bug", color: null };
    const team = { id: "BugT", name: "Bug", color: null };
    expect([workspace, team].map(issueLabelId)).toEqual(["BugW", "BugT"]);
    const base = detail({ tracker: IssueTrackerKind.make("linear"), labels: [workspace] });
    const added = pick(base, "labels", null, "BugT");
    expect(added.ids).toEqual(["BugW", "BugT"]);
    const stale = { ...base, labels: [{ ...workspace }] };
    const removed = pick(stale, "labels", added, "BugT");
    expect(removed.ids).toEqual(["BugW"]);
    expect(issuePickerIds(stale, "labels", added, environmentId)).toEqual(["BugW", "BugT"]);
    const ack = { ...base, labels: [team, workspace] };
    expect(heldIssuePicker(ack, "labels", added, environmentId)).toBeNull();
    expect(nextIssuePickerIds(ack, "labels", null, "BugT", environmentId)).toEqual(["BugW"]);
    expect(nextIssuePickerIds(ack, "labels", null, "BugW", environmentId)).toEqual(["BugT"]);
  });

  it("matches native label ids exactly and ignores label name changes when acknowledging the sent set", () => {
    const base = detail({ labels: [{ id: "BugW", name: "Bug", color: null }] });
    expect(nextIssuePickerIds(base, "labels", null, "bugw", environmentId)).toEqual([
      "BugW",
      "bugw",
    ]);
    const held = pick(base, "labels", null, "BugT");
    const renamed = {
      ...base,
      labels: [
        { id: "BugW", name: "Renamed", color: null },
        { id: "BugT", name: "Bug", color: null },
      ],
    };
    expect(heldIssuePicker(renamed, "labels", held, environmentId)).toBeNull();
    expect(issuePickerIds(renamed, "labels", null, environmentId)).toEqual(["BugW", "BugT"]);
  });

  it("preserves exact names for old label data without native ids", () => {
    const base = detail({ labels: [{ name: "Bug", color: null }] });
    expect(base.labels.map(issueLabelId)).toEqual(["Bug"]);
    const held = pick(base, "labels", null, "Docs");
    expect(held.ids).toEqual(["Bug", "Docs"]);
    expect(pick(base, "labels", held, "Docs").ids).toEqual(["Bug"]);
    expect(pick(base, "labels", held, "bug").ids).toEqual(["Bug", "Docs", "bug"]);
    const ack = {
      ...base,
      labels: [
        { name: "Docs", color: null },
        { name: "Bug", color: null },
      ],
    };
    expect(heldIssuePicker(ack, "labels", held, environmentId)).toBeNull();
  });

  it("adds assignees by native id on multi-assignee trackers and replaces on single-assignee ones", () => {
    const stale = detail({ assignees: [{ id: "u-1", login: "ada", name: null, avatarUrl: null }] });
    const first = pick(stale, "assignees", null, "u-2");
    expect(pick(stale, "assignees", first, "u-3").ids).toEqual(["u-1", "u-2", "u-3"]);
    const single = detail({
      assignees: [{ id: "u-1", login: "ada", name: null, avatarUrl: null }],
      capabilities: { ...detail().capabilities, maxAssignees: 1 },
    });
    const replaced = pick(single, "assignees", null, "u-2");
    expect(pick(single, "assignees", replaced, "u-3").ids).toEqual(["u-3"]);
  });

  it("acknowledges whole label sets without order, but keeps exact names until acknowledgement", () => {
    const base = detail();
    const held = pick(base, "labels", null, "ui");
    const differentCase = detail({
      labels: [
        { name: "bug", color: null },
        { name: "UI", color: null },
      ],
    });
    expect(issuePickerIds(differentCase, "labels", held, environmentId)).toEqual(["bug", "ui"]);
    const ack = detail({
      labels: [
        { name: "ui", color: "ff0000" },
        { name: "bug", color: null },
      ],
    });
    const cleared = heldIssuePicker(ack, "labels", held, environmentId);
    expect(cleared).toBeNull();
    const nextNative = detail({ labels: [{ name: "security", color: null }] });
    expect(issuePickerIds(nextNative, "labels", cleared, environmentId)).toEqual(["security"]);
  });

  it("keeps a confirmed remove and empty set across older reads until the native set acknowledges them", () => {
    const base = detail({
      labels: [
        { name: "bug", color: null },
        { name: "ui", color: null },
      ],
    });
    const removed = pick(base, "labels", null, "bug");
    expect(issuePickerIds({ ...base }, "labels", removed, environmentId)).toEqual(["ui"]);
    const cleared = pick(base, "labels", removed, "ui");
    expect(issuePickerIds({ ...base }, "labels", cleared, environmentId)).toEqual([]);
    const oldRemoveRead = detail({ labels: [{ name: "ui", color: null }] });
    expect(issuePickerIds(oldRemoveRead, "labels", cleared, environmentId)).toEqual([]);
    expect(heldIssuePicker(detail({ labels: [] }), "labels", cleared, environmentId)).toBeNull();
    expect(
      heldIssuePicker(base, "labels", { ...cleared, ids: ["bug", "ui"] }, environmentId),
    ).not.toBeNull();
  });

  it("keeps the earlier confirmed set after a failed write and a stale detail read", async () => {
    let issue = detail();
    let confirmed = pick(issue, "labels", null, "ui");
    const base = issue;
    const desired = nextIssuePickerIds(issue, "labels", confirmed, "docs", environmentId);
    const write = Promise.withResolvers<void>();
    const completion = write.promise.then(() => {
      confirmed = { base, ids: desired, kind: "labels", environmentId };
    });
    issue = detail();
    write.reject(new Error("write failed"));
    await expect(completion).rejects.toThrow("write failed");
    expect(issuePickerIds(issue, "labels", confirmed, environmentId)).toEqual(["bug", "ui"]);
    expect(nextIssuePickerIds(issue, "labels", confirmed, "test", environmentId)).toEqual([
      "bug",
      "ui",
      "test",
    ]);
  });

  it("retains interleaved native assignee sets and acknowledges matching native ids without case", () => {
    const actor = (id: string) => ({ id, login: id, name: null, avatarUrl: null });
    const base = detail({ assignees: [actor("u-1")] });
    const added = pick(base, "assignees", null, "u-2");
    const second = pick(base, "assignees", added, "u-3");
    const stale = detail({ assignees: [actor("U-2"), actor("U-1")] });
    expect(nextIssuePickerIds(stale, "assignees", second, "u-4", environmentId)).toEqual([
      "u-1",
      "u-2",
      "u-3",
      "u-4",
    ]);
    const ack = detail({ assignees: [actor("U-3"), actor("U-1"), actor("U-2")] });
    const cleared = heldIssuePicker(ack, "assignees", second, environmentId);
    expect(cleared).toBeNull();
    expect(issuePickerIds(ack, "assignees", cleared, environmentId)).toEqual(["U-3", "U-1", "U-2"]);
    expect(nextIssuePickerIds(stale, "assignees", second, "U-2", environmentId)).toEqual([
      "u-1",
      "u-3",
    ]);
    const removed = { ...second, base: stale, ids: [] };
    expect(issuePickerIds(ack, "assignees", removed, environmentId)).toEqual([]);
    expect(heldIssuePicker(detail(), "assignees", removed, environmentId)).toBeNull();
  });

  it.each([
    { issue: detail(), kind: "labels" as const, environmentId: "other" },
    { issue: detail(), kind: "assignees" as const, environmentId },
    { issue: detail({ key: "2" }), kind: "labels" as const, environmentId },
    {
      issue: detail({ tracker: IssueTrackerKind.make("jira") }),
      kind: "labels" as const,
      environmentId,
    },
    {
      issue: detail({ projectId: ProjectId.make("other") }),
      kind: "labels" as const,
      environmentId,
    },
    { issue: detail({ host: "other.example" }), kind: "labels" as const, environmentId },
    { issue: detail({ scope: "other/repo" }), kind: "labels" as const, environmentId },
  ])("does not carry confirmed picks to another context %j", (target) => {
    const held = pick(detail(), "labels", null, "ui");
    expect(heldIssuePicker(target.issue, target.kind, held, target.environmentId)).toBeNull();
    expect(issuePickerIds(target.issue, target.kind, held, target.environmentId)).toEqual(
      target.kind === "labels" ? ["bug"] : [],
    );
  });
});

describe("issue picker confirmed set across sheet close and reopen", () => {
  const actor = (id: string) => ({ id, login: id, name: null, avatarUrl: null });

  it("keeps the confirmed set for the same issue and kind until the native set acknowledges it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const registry = AtomRegistry.make({ defaultIdleTTL: 1, timeoutResolution: 1 });
    try {
      const stale = detail({ assignees: [actor("u-1")] });
      const labels = issuePickerKey(environmentId, stale, "labels");
      const assignees = issuePickerKey(environmentId, stale, "assignees");
      const open = registry.mount(issuePickerConfirmed(labels));
      registry.set(issuePickerConfirmed(labels), pick(stale, "labels", null, "ui"));
      open();
      registry.set(issuePickerConfirmed(assignees), pick(stale, "assignees", null, "u-2"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(60_000);

      const reopened = registry.mount(issuePickerConfirmed(labels));
      const oldRead = { ...stale };
      clearAcknowledgedIssuePicker(registry, labels, oldRead, "labels", environmentId);
      const held = registry.get(issuePickerConfirmed(labels));
      expect(nextIssuePickerIds(oldRead, "labels", held, "docs", environmentId)).toEqual([
        "bug",
        "ui",
        "docs",
      ]);
      const people = registry.get(issuePickerConfirmed(assignees));
      expect(nextIssuePickerIds(oldRead, "assignees", people, "u-3", environmentId)).toEqual([
        "u-1",
        "u-2",
        "u-3",
      ]);

      for (const other of [
        issuePickerKey("other", stale, "labels"),
        issuePickerKey(environmentId, { ...stale, key: "2" }, "labels"),
        issuePickerKey(environmentId, { ...stale, scope: "org/other" }, "labels"),
      ]) {
        expect(registry.get(issuePickerConfirmed(other))).toBeNull();
      }

      const ack = detail({
        labels: [
          { name: "ui", color: null },
          { name: "bug", color: null },
        ],
      });
      clearAcknowledgedIssuePicker(registry, labels, ack, "labels", environmentId);
      expect(registry.get(issuePickerConfirmed(labels))).toBeNull();
      reopened();

      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      expect(registry.get(issuePickerConfirmed(assignees))).toBeNull();
    } finally {
      registry.dispose();
      vi.useRealTimers();
    }
  });
});

describe("issue picker confirmed set across a viewer change", () => {
  it.each([
    { kind: "labels" as const, id: "ui", native: ["bug"] },
    { kind: "assignees" as const, id: "u-2", native: [] },
  ])(
    "drops $kind held for another viewer and keeps it for the same viewer",
    ({ kind, id, native }) => {
      const registry = AtomRegistry.make();
      try {
        for (const [from, to, held] of [
          ["A", "B", false],
          ["A", null, false],
          [null, "B", false],
          ["A", "A", true],
        ] as const) {
          const before = detail({ viewer: from });
          const key = issuePickerKey(environmentId, before, kind);
          const release = registry.mount(issuePickerConfirmed(key));
          registry.set(issuePickerConfirmed(key), pick(before, kind, null, id));
          const after = detail({ viewer: to });
          clearAcknowledgedIssuePicker(registry, key, after, kind, environmentId);
          const confirmed = registry.get(issuePickerConfirmed(key));
          expect(issuePickerIds(after, kind, confirmed, environmentId)).toEqual(
            held ? [...native, id] : native,
          );
          expect(confirmed !== null).toBe(held);
          release();
        }
      } finally {
        registry.dispose();
      }
    },
  );
});

it.each(["labels", "assignees"] as const)(
  "keeps cached %s and drops an unknown owner's whole set after a new detail",
  (kind) => {
    const registry = AtomRegistry.make();
    const before = detail({ viewer: null });
    const key = issuePickerKey(environmentId, before, kind);
    const held = pick(before, kind, null, "added-by-A");
    try {
      registry.set(issuePickerConfirmed(key), held);
      clearAcknowledgedIssuePicker(registry, key, before, kind, environmentId);
      expect(
        issuePickerIds(before, kind, registry.get(issuePickerConfirmed(key)), environmentId),
      ).toEqual(held.ids);
      const after = detail({
        viewer: null,
        labels: [{ name: "native-B", color: null }],
        assignees: [{ id: "native-B", login: "B", name: null, avatarUrl: null }],
      });
      clearAcknowledgedIssuePicker(registry, key, after, kind, environmentId);
      const confirmed = registry.get(issuePickerConfirmed(key));
      expect(issuePickerIds(after, kind, confirmed, environmentId)).toEqual(["native-B"]);
      expect(nextIssuePickerIds(after, kind, confirmed, "next", environmentId)).toEqual([
        "native-B",
        "next",
      ]);
      expect(confirmed).toBeNull();
    } finally {
      registry.dispose();
    }
  },
);

describe("issue picker write across sheet close and reopen", () => {
  it("refuses a second write while the first is pending, then writes from its confirmed set", async () => {
    const registry = AtomRegistry.make({ defaultIdleTTL: 1, timeoutResolution: 1 });
    const stale = detail();
    const key = issuePickerKey(environmentId, stale, "labels");
    const sent: string[][] = [];
    const toggle = (id: string, gate: Promise<void>) =>
      writeIssuePicker(registry, key, id, async () => {
        const next = pick(stale, "labels", registry.get(issuePickerConfirmed(key)), id);
        sent.push([...next.ids]);
        await gate;
        return next;
      });
    try {
      const first = Promise.withResolvers<void>();
      const open = registry.mount(issuePickerConfirmed(key));
      const ui = toggle("ui", first.promise);
      open();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));

      const reopen = registry.mount(issuePickerConfirmed(key));
      expect(registry.get(issuePickerPending(key))).toBe("ui");
      await toggle("docs", Promise.resolve());
      expect(registry.get(issuePickerPending(issuePickerKey("other", stale, "labels")))).toBeNull();
      first.resolve();
      await ui;
      expect(registry.get(issuePickerPending(key))).toBeNull();
      await toggle("docs", Promise.resolve());
      expect(sent).toEqual([
        ["bug", "ui"],
        ["bug", "ui", "docs"],
      ]);

      const failed = toggle("test", Promise.reject(new Error("write failed")));
      expect(registry.get(issuePickerPending(key))).toBe("test");
      await expect(failed).rejects.toThrow("write failed");
      expect(registry.get(issuePickerPending(key))).toBeNull();
      expect(registry.get(issuePickerConfirmed(key))!.ids).toEqual(["bug", "ui", "docs"]);
      reopen();
    } finally {
      registry.dispose();
    }
  });
});
