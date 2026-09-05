import { expect, it } from "vite-plus/test";
import * as Result from "effect/Result";
import { decodeTimelineEventsJson as github } from "./gitHubPullRequestJson.ts";
import { decodeNotesJson as gitlab } from "./gitLabMergeRequestJson.ts";
import { decodeTimelineEventsJson as bitbucket } from "./bitbucketPullRequestJson.ts";
import { decodeThreadsJson as azure } from "./azureDevOpsPullRequestJson.ts";

const date = "2026-09-05T12:00:00Z";

it("keeps GitHub events and related PR metadata without repeating comments or reviews", () => {
  const event = {
    id: 1,
    event: "cross-referenced",
    created_at: date,
    actor: { login: "bilal", avatar_url: "https://example.com/avatar" },
    source: {
      issue: {
        id: 9,
        title: "Follow-up",
        state: "closed",
        html_url: "https://github.com/acme/web/pull/9",
        pull_request: { merged_at: date },
      },
    },
  };
  const decoded = github(
    JSON.stringify([
      event,
      event,
      { ...event, id: 2, event: "commented" },
      { ...event, id: 3, event: "reviewed" },
      {
        id: 4,
        event: "review_requested",
        created_at: date,
        requested_reviewer: { login: "octocat" },
      },
    ]),
  );
  expect(Result.isSuccess(decoded)).toBe(true);
  if (!Result.isSuccess(decoded)) return;
  expect(decoded.success.rawCount).toBe(5);
  expect(decoded.success.events).toHaveLength(2);
  expect(decoded.success.events[0]).toMatchObject({
    id: "github:1",
    actor: { login: "bilal" },
    createdAt: date,
    body: "Follow\\-up\n\nhttps://github.com/acme/web/pull/9",
    relatedPullRequest: { title: "Follow-up", state: "merged", url: event.source.issue.html_url },
  });
  expect(decoded.success.events[1]?.body).toBe("@octocat");
});

it("uses native GitHub event details without repeating lifecycle titles", () => {
  const decoded = github(
    JSON.stringify(
      [
        { event: "labeled", label: { name: "bug [ui]" } },
        { event: "unlabeled", label: { name: "bug" } },
        { event: "review_requested", requested_team: { name: "Core team" } },
        { event: "renamed", rename: { from: "Old *title*", to: "New title" } },
        { event: "closed" },
        { event: "reopened" },
        { event: "mentioned" },
      ].map((event, id) => ({ ...event, id, created_at: date })),
    ),
  );
  expect(Result.isSuccess(decoded)).toBe(true);
  if (!Result.isSuccess(decoded)) return;
  expect(decoded.success.events.map((event) => event.body)).toEqual([
    "bug \\[ui\\]",
    "bug",
    "Core team",
    "Old \\*title\\* → New title",
    "",
    "",
    "",
  ]);
});

it("separates GitLab system notes from user comments", () => {
  const decoded = gitlab(
    JSON.stringify([
      {
        id: 1,
        body: "marked this merge request as draft",
        system: true,
        author: { username: "bilal" },
        created_at: date,
      },
      { id: 2, body: "Ready soon", created_at: date },
    ]),
  );
  expect(Result.isSuccess(decoded)).toBe(true);
  if (!Result.isSuccess(decoded)) return;
  expect(decoded.success.comments.map((comment) => comment.id)).toEqual(["2"]);
  expect(decoded.success.timelineEvents).toMatchObject([
    {
      id: "note:1",
      body: "marked this merge request as draft",
      actor: { login: "bilal" },
      createdAt: date,
    },
  ]);
});

it.each([
  ["merged", "merged"],
  ["merged manually", "merged"],
  ["merged with abc123", "merged"],
  ["closed", "closed"],
  ["closed via commit abc123", "closed"],
  ["merged results pipeline enabled", "system"],
])("normalizes GitLab lifecycle note %s", (body, kind) => {
  const decoded = gitlab(
    JSON.stringify([
      { id: 1, system: true, body, created_at: date, author: { username: "bilal" } },
      { id: 2, system: true, body, created_at: date },
    ]),
  );
  expect(Result.isSuccess(decoded)).toBe(true);
  if (!Result.isSuccess(decoded)) return;
  expect(decoded.success.timelineEvents).toMatchObject([
    { kind, actor: { login: "bilal" } },
    { kind, actor: null },
  ]);
});

it("reads Bitbucket updates and past approvals without repeating comments", () => {
  const decoded = bitbucket(
    JSON.stringify({
      values: [
        {
          update: { date, state: "MERGED", author: { nickname: "bilal" } },
          pull_request: {
            links: { html: { href: "https://bitbucket.org/acme/web/pull-requests/7" } },
          },
        },
        { approval: { date, user: { nickname: "julius" } } },
        { comment: { content: { raw: "Hi" } } },
      ],
      next: "/activity?page=2",
    }),
  );
  expect(Result.isSuccess(decoded)).toBe(true);
  if (!Result.isSuccess(decoded)) return;
  expect(decoded.success.items.map((event) => event.kind)).toEqual(["merged", "approved"]);
  expect(decoded.success.items[0]?.url).toContain("/pull-requests/7");
  expect(decoded.success.next).toBe("/activity?page=2");
});

it("reads Bitbucket change requests with their actor and time", () => {
  const decoded = bitbucket(
    JSON.stringify({
      values: [
        {
          request_changes: { date, user: { nickname: "julius" } },
          pull_request: {
            links: { html: { href: "https://bitbucket.org/acme/web/pull-requests/7" } },
          },
        },
      ],
    }),
  );
  expect(Result.isSuccess(decoded)).toBe(true);
  if (!Result.isSuccess(decoded)) return;
  expect(decoded.success.items).toMatchObject([
    {
      kind: "changes-requested",
      actor: { login: "julius" },
      createdAt: "2026-09-05T12:00:00.000Z",
      url: "https://bitbucket.org/acme/web/pull-requests/7",
    },
  ]);
});

it.each([
  ["MERGED", "merged"],
  ["DECLINED", "closed"],
  ["SUPERSEDED", "closed"],
  ["UNKNOWN", "updated"],
])("normalizes Bitbucket lifecycle state %s", (state, kind) => {
  const decoded = bitbucket(
    JSON.stringify({
      values: [
        { update: { date, state, author: { nickname: "bilal" } } },
        { update: { date, state } },
      ],
    }),
  );
  expect(Result.isSuccess(decoded)).toBe(true);
  if (!Result.isSuccess(decoded)) return;
  expect(decoded.success.items).toMatchObject([
    { kind, actor: { login: "bilal" } },
    { kind, actor: null },
  ]);
});

it("reads Azure system events separately and ignores deleted threads", () => {
  const raw = JSON.stringify({
    value: [
      {
        id: 1,
        comments: [
          { id: 1, commentType: "system", content: "Marked as draft", publishedDate: date },
          { id: 2, commentType: "text", content: "Hi", publishedDate: date },
        ],
      },
      {
        id: 2,
        isDeleted: true,
        comments: [{ commentType: "system", content: "Old", publishedDate: date }],
      },
    ],
  });
  const activity = azure(raw);
  expect(Result.isSuccess(activity)).toBe(true);
  if (!Result.isSuccess(activity)) return;
  expect(activity.success.timelineEvents).toMatchObject([
    { id: "azure:1:1", body: "Marked as draft", createdAt: date },
  ]);
  expect(activity.success.comments.map((comment) => comment.body)).toEqual(["Hi"]);
});

it.each([
  ["StatusUpdate", "Completed", "merged"],
  ["StatusUpdate", "Abandoned", "closed"],
  ["StatusUpdate", "Unknown", "system"],
  ["Unknown", "Completed", "system"],
])("normalizes Azure lifecycle metadata %s/%s", (threadType, status, kind) => {
  const decoded = azure(
    JSON.stringify({
      value: [
        {
          id: 1,
          properties: {
            CodeReviewThreadType: { $value: threadType },
            CodeReviewStatus: { $value: status },
          },
          comments: [
            {
              id: 1,
              commentType: "system",
              content: "Status changed",
              publishedDate: date,
              author: { uniqueName: "bilal" },
            },
            { id: 2, commentType: "system", content: "Status changed", publishedDate: date },
            { id: 3, commentType: "text", content: "User reply", publishedDate: date },
          ],
        },
      ],
    }),
  );
  expect(Result.isSuccess(decoded)).toBe(true);
  if (!Result.isSuccess(decoded)) return;
  expect(decoded.success.timelineEvents).toMatchObject([
    { kind, actor: { login: "bilal" } },
    { kind, actor: null },
  ]);
  expect(decoded.success.comments.map((comment) => comment.body)).toEqual(["User reply"]);
});
