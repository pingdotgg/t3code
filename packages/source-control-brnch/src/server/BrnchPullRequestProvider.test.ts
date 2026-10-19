import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import type { SourceControlProcessInput } from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as BrnchPullRequestProvider from "./BrnchPullRequestProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const ref = { cwd: "/repo", host: "brnch.io", repository: "team/project", number: 12 };

/**
 * A `brnch` answering every run the same way, or by its arguments when given a function, recording
 * each run's arguments and stdin.
 */
function fakeBrnch(stdout: unknown, exitCode = 0) {
  const runs: Array<{ readonly args: ReadonlyArray<string>; readonly stdin?: string }> = [];
  const layer = TestSourceControlHost.layer({
    process: {
      run: (input: SourceControlProcessInput) => {
        runs.push({
          // After `--url https://brnch.io --json`.
          args: input.args.slice(3),
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        });
        return Effect.succeed(
          TestSourceControlHost.processOutput(
            encodeJson(typeof stdout === "function" ? stdout(input.args.slice(3)) : stdout),
            {
              exitCode: ChildProcessSpawner.ExitCode(exitCode),
            },
          ),
        );
      },
    },
  });
  return { runs, layer };
}

const actor = (userId: string, type = "human", names: object = {}) => ({
  type,
  id: type === "human" ? userId : `agt_${userId}`,
  user_id: userId,
  session_id: null,
  display_name: null,
  ...names,
});
const change = (number: number, author: ReturnType<typeof actor>, state = "open") => ({
  id: `chg_${String(number).padStart(4, "0")}`,
  number,
  title: `Change ${number}`,
  description: "",
  state,
  target_ref: "refs/heads/main",
  source: { kind: "ref", workspace_id: null, ref: `refs/heads/change-${number}` },
  author,
  current_revision: { head_oid: `oid${number}` },
  merged: null,
  created_at: `2026-10-01T00:00:${String(number).padStart(2, "0")}Z`,
  updated_at: `2026-10-02T00:00:${String(number).padStart(2, "0")}Z`,
});

describe("BrnchPullRequestProvider", () => {
  it.effect("names the viewer by the handle authors read under", () => {
    const brnch = fakeBrnch({ user: { id: "usr_me", handle: "alice" } });
    return Effect.gen(function* () {
      const provider = yield* BrnchPullRequestProvider.make;
      assert.strictEqual(yield* provider.getViewer({ cwd: "/repo", host: "brnch.io" }), "alice");
      assert.deepStrictEqual(brnch.runs, [{ args: ["auth", "status"] }]);
    }).pipe(Effect.provide(brnch.layer));
  });

  it.effect("names authors by the handle and name Brnch resolves for them", () => {
    const brnch = fakeBrnch({
      items: [
        change(
          3,
          actor("usr_other", "agent", {
            handle: "bob",
            user_name: "Bob Smith",
            display_name: "Codex (Bob Smith)",
          }),
        ),
        change(2, actor("usr_other", "human", { handle: "bob", user_name: "Bob Smith" })),
        // From before Brnch named actors.
        change(1, actor("usr_old")),
      ],
      next_cursor: null,
    });
    return Effect.gen(function* () {
      const provider = yield* BrnchPullRequestProvider.make;
      const page = yield* provider.listChangeRequests({
        ...ref,
        state: "all",
        involvement: "all",
        viewer: "alice",
        limit: 10,
      });
      assert.deepStrictEqual(
        page.items.map((item) => [item.author?.login, item.author?.name]),
        [
          ["bob", "Codex (Bob Smith)"],
          ["bob", "Bob Smith"],
          ["usr_old", null],
        ],
      );
      // Authors are named by the listing alone; the signed-in account is not consulted.
      assert.isTrue(brnch.runs.every((run) => run.args[0] === "change"));
    }).pipe(Effect.provide(brnch.layer));
  });

  it.effect("pages a long list by rows delivered, newest first across open and draft", () => {
    // Open changes 40..1 over two pages, drafts 50..41 on one; cursors are opaque strings.
    const brnch = fakeBrnch((args: ReadonlyArray<string>) => {
      const state = args[args.indexOf("--state") + 1];
      const cursor = args.includes("--cursor") ? args[args.indexOf("--cursor") + 1] : null;
      const numbers =
        state === "draft"
          ? Array.from({ length: 10 }, (_, i) => 50 - i)
          : cursor === null
            ? Array.from({ length: 20 }, (_, i) => 40 - i)
            : Array.from({ length: 20 }, (_, i) => 20 - i);
      return {
        items: numbers.map((number) => change(number, actor("usr_me"), state ?? "open")),
        next_cursor: state === "open" && cursor === null ? "page-2" : null,
      };
    });
    return Effect.gen(function* () {
      const provider = yield* BrnchPullRequestProvider.make;
      const first = yield* provider.listChangeRequests({
        ...ref,
        state: "open",
        involvement: "all",
        viewer: "alice",
        limit: 15,
      });
      assert.deepStrictEqual(
        first.items.map((item) => item.number),
        [50, 49, 48, 47, 46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36],
      );
      assert.deepStrictEqual(
        { truncated: first.truncated, continues: first.continues, advance: first.cursorAdvance },
        { truncated: true, continues: true, advance: 15 },
      );
      // The first slice needs no second page of open changes.
      assert.isFalse(brnch.runs.some((run) => run.args.includes("--cursor")));
      const third = yield* provider.listChangeRequests({
        ...ref,
        state: "open",
        involvement: "all",
        viewer: "alice",
        limit: 15,
        cursor: { updatedBefore: "2026-10-01T00:00:00Z", delivered: 30 },
      });
      assert.deepStrictEqual(
        third.items.map((item) => item.number),
        [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6],
      );
      assert.isTrue(third.truncated);
      const fourth = yield* provider.listChangeRequests({
        ...ref,
        state: "open",
        involvement: "all",
        viewer: "alice",
        limit: 15,
        cursor: { updatedBefore: "2026-10-01T00:00:00Z", delivered: 45 },
      });
      assert.deepStrictEqual(
        fourth.items.map((item) => item.number),
        [5, 4, 3, 2, 1],
      );
      assert.isFalse(fourth.truncated);
    }).pipe(Effect.provide(brnch.layer));
  });

  it.effect("picks out the viewer's own changes while walking, so a slice is full of them", () => {
    // Two pages; the viewer wrote every third change.
    const brnch = fakeBrnch((args: ReadonlyArray<string>) => {
      const cursor = args.includes("--cursor") ? args[args.indexOf("--cursor") + 1] : null;
      const numbers =
        cursor === null
          ? Array.from({ length: 12 }, (_, i) => 24 - i)
          : Array.from({ length: 12 }, (_, i) => 12 - i);
      return {
        items: numbers.map((number) =>
          change(
            number,
            number % 3 === 0 ? actor("usr_me", "human", { handle: "alice" }) : actor("usr_other"),
          ),
        ),
        next_cursor: cursor === null ? "page-2" : null,
      };
    });
    return Effect.gen(function* () {
      const provider = yield* BrnchPullRequestProvider.make;
      const page = yield* provider.listChangeRequests({
        ...ref,
        state: "all",
        involvement: "authored",
        viewer: "alice",
        limit: 5,
      });
      assert.deepStrictEqual(
        page.items.map((item) => item.number),
        [24, 21, 18, 15, 12],
      );
      assert.isTrue(page.truncated);
      assert.strictEqual(page.cursorAdvance, 5);
    }).pipe(Effect.provide(brnch.layer));
  });

  it.effect("counts a change's files from its diff listing", () => {
    const brnch = fakeBrnch((args: ReadonlyArray<string>) =>
      args[1] === "diff"
        ? {
            files: [{ new_path: "README.md" }, { new_path: "install.sh" }, { new_path: null }],
            truncated: false,
          }
        : change(12, actor("usr_me", "human", { handle: "alice" })),
    );
    return Effect.gen(function* () {
      const provider = yield* BrnchPullRequestProvider.make;
      const detail = yield* provider.getChangeRequest(ref);
      assert.strictEqual(detail.changedFiles, 3);
      assert.deepStrictEqual(
        brnch.runs.map((run) => run.args.slice(0, 2)),
        [
          ["change", "view"],
          ["change", "diff"],
        ],
      );
    }).pipe(Effect.provide(brnch.layer));
  });

  it.effect("reports a blocked merge with Brnch's blockers", () => {
    const brnch = fakeBrnch(
      {
        state: "blocked",
        blockers: [{ message: "An approval is required." }],
        error: null,
      },
      7,
    );
    return Effect.gen(function* () {
      const provider = yield* BrnchPullRequestProvider.make;
      const error = yield* Effect.flip(
        provider.runAction({ ...ref, action: "merge", mergeMethod: "squash" }),
      );
      assert.strictEqual(error.detail, "An approval is required.");
      assert.deepStrictEqual(brnch.runs[0]?.args, [
        "merge",
        "request",
        "12",
        "--repo",
        "team/project",
        "--strategy",
        "squash",
      ]);
    }).pipe(Effect.provide(brnch.layer));
  });

  it.effect("accepts a queued merge as Brnch's to finish", () => {
    const brnch = fakeBrnch({ state: "queued", blockers: [], error: null });
    return Effect.gen(function* () {
      const provider = yield* BrnchPullRequestProvider.make;
      yield* provider.runAction({ ...ref, action: "merge" });
    }).pipe(Effect.provide(brnch.layer));
  });

  it.effect("posts a comment over stdin as a thread that does not block the merge", () => {
    const brnch = fakeBrnch({ id: "thr_1" });
    return Effect.gen(function* () {
      const provider = yield* BrnchPullRequestProvider.make;
      yield* provider.comment({ ...ref, body: "--looks good" });
      assert.deepStrictEqual(brnch.runs, [
        {
          args: [
            "review",
            "comment",
            "12",
            "--repo",
            "team/project",
            "--body",
            "-",
            "--non-blocking",
          ],
          stdin: "--looks good",
        },
      ]);
    }).pipe(Effect.provide(brnch.layer));
  });

  it.effect("refuses a host other than brnch.io without running the CLI", () => {
    const brnch = fakeBrnch({});
    return Effect.gen(function* () {
      const provider = yield* BrnchPullRequestProvider.make;
      yield* Effect.flip(provider.getChangeRequest({ ...ref, host: "staging.brnch.io" }));
      assert.deepStrictEqual(brnch.runs, []);
    }).pipe(Effect.provide(brnch.layer));
  });
});
