/** Wire shapes as entire-api renders them, trimmed to fields T3 Code reads plus a few it ignores. */

export const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

const identity = (name: string) => ({
  display_name: name,
  avatar_url: "https://avatars.example/a.png",
});

export const trail = {
  number: 7,
  url: "https://entire.com/gh/acme/web/trails/7/add-the-thing",
  title: "Add the thing",
  status: "open",
  branch: "feature",
  original_branch: null,
  base: "main",
  author: { login: "alice", identity: identity("Alice") },
  reviewers: [
    { login: "bob", status: "changes_requested", identity: identity("Bob") },
    { login: "", status: "pending", identity: identity("Nobody") },
  ],
  ready_for_review: true,
  created_at: "2026-10-01T10:00:00.000Z",
  updated_at: "2026-10-02T10:00:00.000Z",
  merged_at: null,
  // Unknown to T3 Code, and ignored.
  phase: "reviewing",
};

const enabled = { state: "enabled", reason: null };

export const detail = {
  ...trail,
  body_document: { text_snapshot: "The body", etag: "W/x" },
  actions: {
    approve: enabled,
    merge: enabled,
    merge_with_bypass: { state: "unavailable", reason: "not_applicable" },
  },
  mergeability: {
    mergeable: true,
    behind_by: 2,
    comparison_status: "available",
    conflict_status: "clean",
    head_sha: HEAD_SHA,
    gates: [],
    checks: {
      availability: "available",
      runs: [
        {
          name: "build",
          status: "completed",
          conclusion: "success",
          details_url: "https://ci.example/1",
          app_name: "Buildkite",
        },
        {
          name: "lint",
          status: "in_progress",
          conclusion: null,
          details_url: null,
          app_name: null,
        },
      ],
    },
  },
  merge_base_sha: null,
  head_sha: HEAD_SHA,
};

export const denied = {
  ...detail,
  actions: {
    ...detail.actions,
    approve: { state: "unavailable", reason: "permission_denied" },
    merge: { state: "unavailable", reason: "permission_denied" },
  },
};

/** A trail on a repository whose approvals gate is off: Entire reads it as not ready for review. */
export const approvalsDisabled = {
  ...detail,
  ready_for_review: false,
  actions: { ...detail.actions, approve: { state: "unavailable", reason: "approvals_disabled" } },
};

const gate = (key: string, status: string, rationale: string | null = null, blocking = true) => ({
  gate_key: key,
  gate_type: key,
  blocking,
  status,
  rationale,
});

/** An open trail its approvals and findings gates hold back, with CI reported separately. */
export const blocked = {
  ...detail,
  reviewers: [],
  actions: { ...detail.actions, merge: { state: "blocked", reason: "merge_gates_required" } },
  mergeability: {
    ...detail.mergeability,
    mergeable: false,
    gates: [
      gate("approvals", "failed", "Needs 1 approval"),
      gate("findings", "failed", "Unresolved findings: 1 without a severity"),
      // CI is reported as its own runs; the gate that rolls them up is not shown again.
      gate("checks", "failed", "lint is failing"),
      gate("up_to_date", "passed"),
      gate("base_checks", "pending"),
      gate("docs", "failed", "Advisory only", false),
      gate("security", "skipped"),
    ],
  },
};

/** An open trail whose gates have not passed yet: checks running, merge blocked. */
export const gated = {
  ...detail,
  actions: { ...detail.actions, merge: { state: "blocked", reason: "checks_pending" } },
  mergeability: {
    ...detail.mergeability,
    mergeable: false,
    checks: { ...detail.mergeability.checks, availability: "unavailable", runs: [] },
  },
};

export const timeline = {
  items: [
    { id: "trail-created", kind: "trail_created", actor: null, occurredAt: "2026-10-01T10:00:00Z" },
    {
      id: "commit-abc",
      kind: "commit",
      actor: { login: "alice", identity: identity("Alice") },
      occurredAt: "2026-10-01T11:00:00Z",
      title: "Do the thing",
      commitSha: HEAD_SHA,
    },
    {
      id: "trail-approval-1",
      kind: "approval",
      actor: { login: "bob", identity: identity("Bob") },
      occurredAt: "2026-10-01T12:00:00Z",
      approvalStatus: "changes_requested",
      body: "Rename it",
    },
    {
      id: "comment-1",
      kind: "comment",
      actor: { login: "bob" },
      occurredAt: "2026-10-01T12:30:00Z",
    },
  ],
};

const summary = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: "A thought",
  resolved: false,
  created_at: "2026-10-01T12:30:00.000Z",
  review_comment: null,
  ...extra,
});

export const discussions = {
  items: [
    summary("dsc_1"),
    summary("dsc_2", {
      resolved: true,
      review_comment: {
        id: "rc_1",
        body: "Guard the empty case",
        actor_display_name: "carol",
        created_at: "2026-10-01T12:31:00.000Z",
        location: { file_path: "src/app.ts", start_line: 12, end_line: 14 },
      },
    }),
  ],
};

const message = (id: string, body: string, createdAt: string, replies: Array<unknown> = []) => ({
  id,
  author: "bob",
  identity: identity("Bob"),
  created_at: createdAt,
  body,
  replies,
});

export const discussionDetails: Record<string, unknown> = {
  dsc_1: {
    discussion: discussions.items[0],
    messages: [
      message("msg_1", "Looks close", "2026-10-01T12:30:00.000Z", [
        { id: "msg_2", author: "alice", created_at: "2026-10-01T12:40:00.000Z", body: "Thanks" },
      ]),
    ],
  },
  dsc_2: {
    discussion: discussions.items[1],
    messages: [message("msg_3", "Off by one", "2026-10-01T13:00:00.000Z")],
  },
};
