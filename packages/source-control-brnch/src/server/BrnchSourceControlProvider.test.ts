import { assert, describe, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import type { SourceControlProcessInput } from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as BrnchCli from "./brnchCli.ts";
import * as BrnchSourceControlProvider from "./BrnchSourceControlProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const actor = { type: "human", id: "usr_1", user_id: "usr_1", session_id: null };
const change = (number: number, state: string, ref: string | null, updatedAt: string) => ({
  id: `chg_${number}`,
  number,
  title: `Change ${number}`,
  description: "",
  state,
  target_ref: "refs/heads/main",
  source: { kind: "ref", workspace_id: ref === null ? "ws_1" : null, ref },
  author: actor,
  current_revision: { head_oid: `oid${number}` },
  merged: null,
  created_at: updatedAt,
  updated_at: updatedAt,
});

const context = {
  provider: {
    kind: SourceControlProviderKind.make("brnch"),
    name: "Brnch",
    baseUrl: "https://brnch.io",
  },
  remoteName: "origin",
  remoteUrl: "https://brnch.io/git/team/project.git",
};

/** A `brnch` that answers by subcommand, recording each run's arguments after the global ones. */
function fakeBrnch(
  answer: (args: ReadonlyArray<string>) => { stdout: unknown; exitCode?: number },
) {
  const runs: Array<ReadonlyArray<string>> = [];
  const layer = TestSourceControlHost.layer({
    process: {
      run: (input: SourceControlProcessInput) => {
        assert.strictEqual(input.command, "brnch");
        assert.deepStrictEqual(input.args.slice(0, 3), [...BrnchCli.GLOBAL_ARGS]);
        assert.strictEqual(input.env?.BRNCH_AGENT, "none");
        const args = input.args.slice(3);
        runs.push(args);
        const { stdout, exitCode } = answer(args);
        return Effect.succeed(
          TestSourceControlHost.processOutput(encodeJson(stdout), {
            exitCode: ChildProcessSpawner.ExitCode(exitCode ?? 0),
          }),
        );
      },
    },
  });
  return { runs, layer };
}

describe("parseBrnchRemote", () => {
  it("names the same repository over HTTPS, SSH, and the web page, on brnch.io only", () => {
    for (const url of [
      "https://brnch.io/git/team/project.git",
      "https://user@brnch.io/git/team/project",
      "git@brnch.io:team/project.git",
      "ssh://git@brnch.io/team/project.git",
      "https://brnch.io/team/project",
    ])
      assert.strictEqual(BrnchCli.parseBrnchRemote(url), "team/project", url);
    assert.strictEqual(BrnchCli.parseBrnchRemote("https://github.com/team/project.git"), null);
    assert.strictEqual(
      BrnchCli.parseBrnchRemote("https://staging.brnch.io/git/team/project"),
      null,
    );
  });
});

describe("parseAuthStatus", () => {
  it("reads the signed-in handle and keeps transient failures apart from sign-out", () => {
    const status = (stdout: unknown, exitCode = 0) =>
      BrnchCli.parseAuthStatus({
        stdout: encodeJson(stdout),
        stderr: "",
        exitCode: ChildProcessSpawner.ExitCode(exitCode),
      });
    const signedIn = status({ user: { id: "usr_1", handle: "alice" } });
    assert.strictEqual(signedIn.status, "authenticated");
    assert.deepStrictEqual(signedIn.account, Option.some("alice"));
    assert.strictEqual(
      status({ error: { code: "UNAUTHENTICATED", message: "Log in", exit_code: 3 } }, 3).status,
      "unauthenticated",
    );
    assert.strictEqual(
      status({ error: { code: "UNAVAILABLE", message: "Offline", exit_code: 8 } }, 8).status,
      "unknown",
    );
  });
});

describe("BrnchSourceControlProvider", () => {
  it.effect("finds a branch's open changes among Brnch's open and draft lists", () => {
    const brnch = fakeBrnch((args) => {
      const state = args[args.indexOf("--state") + 1];
      return {
        stdout: {
          items:
            state === "open"
              ? [
                  change(3, "open", "refs/heads/other", "2026-10-03T00:00:00Z"),
                  change(2, "open", "refs/heads/feature", "2026-10-02T00:00:00Z"),
                ]
              : [
                  change(4, "draft", "refs/heads/feature", "2026-10-04T00:00:00Z"),
                  change(5, "draft", null, "2026-10-05T00:00:00Z"),
                ],
          next_cursor: null,
        },
      };
    });
    return Effect.gen(function* () {
      const provider = yield* BrnchSourceControlProvider.make;
      const changes = yield* provider.listChangeRequests({
        cwd: "/repo",
        context,
        headSelector: "feature",
        state: "open",
      });
      assert.deepStrictEqual(
        changes.map((item) => [item.number, item.headRefName, item.baseRefName, item.isDraft]),
        [
          [2, "feature", "main", undefined],
          [4, "feature", "main", true],
        ],
      );
      assert.strictEqual(changes[0]?.url, "https://brnch.io/team/project/changes/2");
      assert.deepStrictEqual(
        brnch.runs.map((args) => args[args.indexOf("--state") + 1]),
        ["open", "draft"],
      );
    }).pipe(Effect.provide(brnch.layer));
  });

  it.effect("walks every page of a long list to find a branch's change", () => {
    // Seven pages of a hundred changes on other branches, then the one being looked for.
    const brnch = fakeBrnch((args) => {
      const state = args[args.indexOf("--state") + 1];
      const page = args.includes("--cursor") ? Number(args[args.indexOf("--cursor") + 1]) : 0;
      if (state === "draft") return { stdout: { items: [], next_cursor: null } };
      const last = page === 7;
      return {
        stdout: {
          items: last
            ? [change(1, "open", "refs/heads/feature", "2026-09-01T00:00:00Z")]
            : Array.from({ length: 100 }, (_, i) =>
                change(1000 - page * 100 - i, "open", "refs/heads/other", "2026-10-01T00:00:00Z"),
              ),
          next_cursor: last ? null : String(page + 1),
        },
      };
    });
    return Effect.gen(function* () {
      const provider = yield* BrnchSourceControlProvider.make;
      const changes = yield* provider.listChangeRequests({
        cwd: "/repo",
        context,
        headSelector: "feature",
        state: "open",
      });
      assert.deepStrictEqual(
        changes.map((item) => item.number),
        [1],
      );
      assert.strictEqual(
        brnch.runs.filter((args) => args[args.indexOf("--state") + 1] === "open").length,
        8,
      );
    }).pipe(Effect.provide(brnch.layer));
  });

  it.effect("opens a change from the branch against its base with the body file", () => {
    const brnch = fakeBrnch(() => ({
      stdout: change(7, "open", "refs/heads/feature", "2026-10-01T00:00:00Z"),
    }));
    return Effect.gen(function* () {
      const provider = yield* BrnchSourceControlProvider.make;
      yield* provider.createChangeRequest({
        cwd: "/repo",
        context,
        baseRefName: "main",
        headSelector: "feature",
        title: "Add brnch",
        bodyFile: "/tmp/body.md",
      });
      assert.deepStrictEqual(brnch.runs, [
        [
          "change",
          "create",
          "--repo",
          "team/project",
          "--ref",
          "refs/heads/feature",
          "--target",
          "refs/heads/main",
          "--title",
          "Add brnch",
          "--file",
          "/tmp/body.md",
        ],
      ]);
    }).pipe(Effect.provide(brnch.layer));
  });

  it.effect("reports Brnch's own reason when the CLI refuses", () => {
    const brnch = fakeBrnch(() => ({
      stdout: { error: { code: "NOT_FOUND", message: "No repository team/project", exit_code: 4 } },
      exitCode: 4,
    }));
    return Effect.gen(function* () {
      const provider = yield* BrnchSourceControlProvider.make;
      const error = yield* Effect.flip(provider.getDefaultBranch({ cwd: "/repo", context }));
      assert.strictEqual(error.detail, "No repository team/project");
    }).pipe(Effect.provide(brnch.layer));
  });
});
