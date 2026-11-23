import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as RadicleIssueTracker from "./RadicleIssueTracker.ts";
import {
  AUTHOR,
  ISSUE,
  ISSUE_COMMENT,
  RID,
  VIEWER,
  radicleLayer,
  type Run,
} from "./radicleTestFixtures.ts";

const at = { cwd: "/repo", host: "radicle", scope: `rad:${RID.toLowerCase()}` };
const issueArgs = (runs: ReadonlyArray<Run>) =>
  runs.filter((run) => run.command === "rad" && run.args[0] === "issue").map((run) => run.args);

it.effect("lists issues by ID with aliases, labels and assignees, filtered locally", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const tracker = yield* RadicleIssueTracker.make;
    const list = (input: Partial<Parameters<typeof tracker.listIssues>[0]>) =>
      tracker.listIssues({
        ...at,
        state: "open",
        involvement: "all",
        limit: 10,
        sort: "updated",
        ...input,
      } as Parameters<typeof tracker.listIssues>[0]);
    const page = yield* list({});
    const [issue] = page.items;
    assert.strictEqual(issue?.key, ISSUE);
    assert.strictEqual(issue?.displayKey, ISSUE.slice(0, 7));
    assert.strictEqual(issue?.author?.login, "author@laptop");
    assert.deepStrictEqual(
      issue?.assignees.map((assignee) => assignee.login),
      ["viewer@bridge"],
    );
    assert.deepStrictEqual(issue?.labels, [{ name: "test", color: null }]);
    assert.strictEqual(issue?.commentCount, 1);
    assert.strictEqual(
      issue?.url,
      `https://radicle.network/nodes/seed.radicle.dev/rad:${RID}/issues/${ISSUE}`,
    );
    assert.strictEqual(page.nextCursor, null);
    assert.lengthOf((yield* list({ state: "closed" })).items, 0);
    assert.lengthOf((yield* list({ labels: ["bug"] })).items, 0);
    assert.lengthOf((yield* list({ assignee: "viewer@bridge" })).items, 1);
    assert.lengthOf((yield* list({ involvement: "authored", viewer: "viewer@bridge" })).items, 0);
  }).pipe(Effect.provide(radicleLayer({ runs })));
});

it.effect("reads the description apart from the comments that follow it", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const tracker = yield* RadicleIssueTracker.make;
    const detail = yield* tracker.getIssue({ ...at, key: ISSUE.slice(0, 10) });
    assert.strictEqual(detail.body, "An open issue.");
    assert.deepStrictEqual(
      detail.comments.map((comment) => [comment.id, comment.body, comment.author?.login]),
      [[ISSUE_COMMENT, "A comment", "viewer@bridge"]],
    );
    assert.deepStrictEqual(
      detail.states.map((state) => state.name),
      ["open", "solved", "closed"],
    );
    // The viewer is neither a delegate nor the author here.
    assert.isFalse(detail.viewerPermissions.setState);
    assert.isTrue(detail.viewerPermissions.comment);
  }).pipe(Effect.provide(radicleLayer({ runs })));
});

it.effect("files an issue without opening an editor and reads its ID back", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const tracker = yield* RadicleIssueTracker.make;
    const created = yield* tracker.create!({
      ...at,
      title: "New issue",
      body: "",
      labels: ["bug", "ui"],
      assignees: ["author@laptop"],
    });
    assert.strictEqual(created.key, ISSUE);
    assert.deepStrictEqual(issueArgs(runs), [
      [
        "issue",
        "open",
        "--title",
        "New issue",
        "--description",
        "",
        "--labels",
        "bug",
        "--labels",
        "ui",
        "--assignees",
        `did:key:${AUTHOR}`,
        "--repo",
        `rad:${RID}`,
      ],
    ]);
  }).pipe(Effect.provide(radicleLayer({ runs })));
});

it.effect("changes only the labels and assignees that differ, and sets states by flag", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const tracker = yield* RadicleIssueTracker.make;
    yield* tracker.update!({
      ...at,
      key: ISSUE,
      labels: ["test", "bug"],
      assignees: ["author@laptop"],
    });
    yield* tracker.setState!({ ...at, key: ISSUE, state: "solved" });
    const repo = ["--repo", `rad:${RID}`];
    assert.deepStrictEqual(issueArgs(runs), [
      ["issue", "label", ISSUE, "--add", "bug", ...repo],
      [
        "issue",
        "assign",
        ISSUE,
        "--add",
        `did:key:${AUTHOR}`,
        "--delete",
        `did:key:${VIEWER}`,
        ...repo,
      ],
      ["issue", "state", "--solved", ISSUE, ...repo],
    ]);
  }).pipe(Effect.provide(radicleLayer({ runs })));
});

it.effect("keeps an assignee a client names by shortened node ID when adding another", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const tracker = yield* RadicleIssueTracker.make;
    // With no alias, the viewer's login is the short node ID clients send back.
    const viewerLogin = `${VIEWER.slice(0, 7)}…${VIEWER.slice(-7)}`;
    yield* tracker.update!({ ...at, key: ISSUE, assignees: [viewerLogin, "author@laptop"] });
    assert.deepStrictEqual(issueArgs(runs), [
      ["issue", "assign", ISSUE, "--add", `did:key:${AUTHOR}`, "--repo", `rad:${RID}`],
    ]);
  }).pipe(Effect.provide(radicleLayer({ runs, viewerAlias: null })));
});

it.effect("restores the case of another repository's ID from the node's storage", () => {
  const runs: Array<Run> = [];
  const other = "zOtherRepoABCDEFGHJKmnpqrst";
  return Effect.gen(function* () {
    const tracker = yield* RadicleIssueTracker.make;
    yield* tracker.setState!({
      ...at,
      scope: `rad:${other.toLowerCase()}`,
      key: ISSUE,
      state: "closed",
    });
    assert.deepStrictEqual(issueArgs(runs).at(-1)?.slice(-2), ["--repo", `rad:${other}`]);
  }).pipe(Effect.provide(radicleLayer({ runs, storage: [RID, other] })));
});

it.effect("assigns a peer the node knows by alias, though not a delegate or assignee", () => {
  const runs: Array<Run> = [];
  return Effect.gen(function* () {
    const tracker = yield* RadicleIssueTracker.make;
    yield* tracker.create!({
      ...at,
      title: "x",
      body: "",
      labels: [],
      assignees: ["viewer@bridge"],
    });
    assert.deepStrictEqual(issueArgs(runs)[0]?.slice(6, 8), ["--assignees", `did:key:${VIEWER}`]);
  }).pipe(Effect.provide(radicleLayer({ runs })));
});
