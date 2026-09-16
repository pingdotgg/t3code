import { expect, it, vi, afterEach } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ForgejoCli, ForgejoCliError } from "../sourceControl/ForgejoCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Provider from "./ForgejoPullRequestProvider.ts";

const api = vi.fn<ForgejoCli["Service"]["api"]>();
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  exitCode: ChildProcessSpawner.ExitCode(0),
});
const json = (value: unknown) => encode(value).pipe(Effect.orDie, Effect.map(output));
const input = { cwd: "/repo", repository: "owner/repo", host: "forgejo.test", number: 1 };
const pull = {
  number: 1,
  title: "Large diff",
  body: null,
  html_url: "https://forgejo.test/owner/repo/pulls/1",
  user: null,
  state: "open",
  merged: false,
  head: { ref: "feature", sha: "head", repo: null },
  base: { ref: "main", sha: "base", repo: null },
  merge_base: "merge-base",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  closed_at: null,
  merged_at: null,
  labels: [],
};
const runtime = Layer.mergeAll(Layer.mock(ForgejoCli)({ api }), VcsProcess.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

afterEach(() => api.mockReset());

it.effect("emits ordinary rename paths without literal quotes", () =>
  Effect.gen(function* () {
    api.mockImplementation((request) => {
      if (request.path.endsWith("/pulls/1")) return json(pull);
      if (request.path.includes("/files?"))
        return json([
          {
            filename: "new.ts",
            previous_filename: "old.ts",
            status: "renamed",
            additions: 0,
            deletions: 0,
          },
        ]);
      if (request.path.includes("/git/trees/"))
        return json({
          truncated: false,
          tree: [
            {
              path: request.path.includes("/head?") ? "new.ts" : "old.ts",
              mode: "100644",
              sha: "blob",
            },
          ],
        });
      return json({ encoding: "base64", content: Buffer.from("unchanged\n").toString("base64") });
    });
    const provider = yield* Provider.make;
    const result = yield* provider.getDiff({ ...input, cursor: "1" });
    expect(result.patch).toBe(
      "diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n",
    );
    expect(result.omittedFileStats).toBeUndefined();
  }).pipe(Effect.provide(runtime)),
);

it.effect("marks non-UTF-8 blobs as omitted instead of losing byte-only changes", () =>
  Effect.gen(function* () {
    api.mockImplementation((request) => {
      if (request.path.endsWith("/pulls/1")) return json(pull);
      if (request.path.includes("/files?"))
        return json([{ filename: "legacy.txt", status: "modified", additions: 1, deletions: 1 }]);
      if (request.path.includes("/git/trees/"))
        return json({
          truncated: false,
          tree: [
            {
              path: "legacy.txt",
              mode: "100644",
              sha: request.path.includes("/head?") ? "new" : "old",
            },
          ],
        });
      if (request.path.includes("/git/blobs/"))
        return json({
          encoding: "base64",
          content: Buffer.from([request.path.endsWith("/new") ? 0x81 : 0x80]).toString("base64"),
        });
      return Effect.die(`Unexpected API path: ${request.path}`);
    });
    const provider = yield* Provider.make;
    const result = yield* provider.getDiff({ ...input, cursor: "1" });
    expect(result.truncated).toBe(true);
    expect(result.patch).toContain("diff --git a/legacy.txt b/legacy.txt\nBinary files differ");
    expect(result.omittedFileStats).toEqual([{ path: "legacy.txt", additions: 1, deletions: 1 }]);
  }).pipe(Effect.provide(runtime)),
);

it.effect("keeps small Forgejo patches on the direct path", () =>
  Effect.gen(function* () {
    api.mockReturnValueOnce(Effect.succeed(output("whole patch")));
    const provider = yield* Provider.make;
    expect(yield* provider.getDiff(input)).toEqual({
      patch: "whole patch",
      truncated: false,
      nextCursor: null,
    });
    expect(api).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(runtime)),
);

it.effect(
  "rebuilds oversized Forgejo diffs in bounded pages, preserving renames and omitted files",
  () =>
    Effect.gen(function* () {
      const files = [
        {
          filename: " new.ts",
          previous_filename: "old.ts",
          status: "renamed",
          additions: 1,
          deletions: 1,
        },
        { filename: "added.ts", status: "added", additions: 1, deletions: 0 },
        { filename: "deleted.ts", status: "deleted", additions: 0, deletions: 1 },
        { filename: "binary.bin", status: "modified", additions: 0, deletions: 0 },
      ];
      api.mockImplementation((request) => {
        if (request.path.endsWith(".diff"))
          return Effect.fail(
            new ForgejoCliError({
              command: "fj",
              cwd: input.cwd,
              reason: "invalid-response",
              detail: "Forgejo returned an oversized or invalid response.",
            }),
          );
        if (request.path.endsWith("/pulls/1")) return json(pull);
        if (request.path.includes("/files?"))
          return json(request.path.endsWith("page=1") ? files : []);
        if (request.path.includes("/git/trees/")) {
          const revision = request.path.includes("/head?") ? "head" : "base";
          return json({
            truncated: false,
            tree: ["old.ts", ...files.map((file) => file.filename)].map((path) => ({
              path,
              mode: "100644",
              sha: `${revision}:${path}`,
            })),
          });
        }
        if (request.path.includes("/git/blobs/")) {
          const text = request.path.includes("binary.bin")
            ? "\0binary"
            : request.path.includes("/head%3A")
              ? "after\n"
              : "before\n";
          return json({ encoding: "base64", content: Buffer.from(text).toString("base64") });
        }
        return Effect.die(`Unexpected API path: ${request.path}`);
      });
      const provider = yield* Provider.make;
      const first = yield* provider.getDiff(input);
      expect(first.nextCursor).toBe("2");
      expect(first.truncated).toBe(true);
      expect(first.patch).toContain('rename to " new.ts"');
      expect(first.patch).toContain("-before\n+after\n");
      expect(first.patch).toContain("new file mode 100644\n--- /dev/null");
      expect(first.patch).toContain("deleted file mode 100644\n--- a/deleted.ts\n+++ /dev/null");
      expect(first.patch).toContain("Binary files differ");
      expect(first.omittedFileStats).toEqual([{ path: "binary.bin", additions: 0, deletions: 0 }]);
      const last = yield* provider.getDiff({ ...input, cursor: "2" });
      expect(last.nextCursor).toBeNull();
      expect(last.patch).toBe("");
      expect(api.mock.calls.filter(([request]) => request.path.endsWith(".diff"))).toHaveLength(1);
    }).pipe(Effect.provide(runtime)),
);

it.effect("keeps later files reachable when tea truncates a file-content response", () =>
  Effect.gen(function* () {
    api.mockImplementation((request) => {
      if (request.path.endsWith(".diff") || request.path.includes("/git/blobs/"))
        return Effect.succeed({ ...output("partial"), stdoutTruncated: true });
      if (request.path.endsWith("/pulls/1")) return json(pull);
      if (request.path.includes("/git/trees/"))
        return json({
          truncated: false,
          tree: [{ path: "large.ts", mode: "100644", sha: "blob" }],
        });
      if (request.path.includes("/files?"))
        return json(
          request.path.endsWith("page=1")
            ? [{ filename: "large.ts", status: "modified", additions: 100000, deletions: 10 }]
            : [],
        );
      return Effect.die(`Unexpected API path: ${request.path}`);
    });
    const provider = yield* Provider.make;
    const first = yield* provider.getDiff(input);
    expect(first.truncated).toBe(true);
    expect(first.patch).toContain("b/large.ts");
    expect(first.omittedFileStats).toEqual([
      { path: "large.ts", additions: 100000, deletions: 10 },
    ]);
    expect(first.nextCursor).toBe("2");
    expect((yield* provider.getDiff({ ...input, cursor: "2" })).nextCursor).toBeNull();
  }).pipe(Effect.provide(runtime)),
);

it.effect("does not mask authentication failures or accept invalid cursors", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.make;
    const invalid = yield* Effect.flip(provider.getDiff({ ...input, cursor: "../2" }));
    expect(invalid.detail).toBe("Invalid diff cursor.");
    expect(api).not.toHaveBeenCalled();
    api.mockReturnValueOnce(
      Effect.fail(
        new ForgejoCliError({
          command: "fj",
          cwd: input.cwd,
          reason: "authentication",
          detail: "Sign in first",
        }),
      ),
    );
    const denied = yield* Effect.flip(provider.getDiff(input));
    expect(denied.reason).toBe("unauthenticated");
    expect(api).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(runtime)),
);

it.effect("preserves executable, symlink, and submodule changes in rebuilt previews", () =>
  Effect.gen(function* () {
    const files = [
      { filename: "tools/script", status: "modified", additions: 0, deletions: 0 },
      { filename: "link", status: "modified", additions: 0, deletions: 0 },
      { filename: "module", status: "modified", additions: 1, deletions: 1 },
    ];
    api.mockImplementation((request) => {
      if (request.path.endsWith("/pulls/1")) return json(pull);
      if (request.path.includes("/files?")) return json(files);
      if (request.path.includes("/git/trees/")) {
        const head = request.path.includes("/head");
        if (request.path.includes("-tools?"))
          return json({
            truncated: false,
            tree: [{ path: "script", mode: head ? "100755" : "100644", sha: "script" }],
          });
        if (request.path.endsWith("page=1"))
          return json({
            truncated: true,
            tree: [{ path: "unrelated", mode: "100644", sha: "unused" }],
          });
        return json({
          truncated: false,
          tree: [
            { path: "tools", mode: "040000", sha: head ? "head-tools" : "base-tools" },
            { path: "link", mode: head ? "120000" : "100644", sha: "target" },
            { path: "module", mode: "160000", sha: head ? "new-commit" : "old-commit" },
          ],
        });
      }
      if (request.path.includes("/git/blobs/"))
        return json({ encoding: "base64", content: Buffer.from("target").toString("base64") });
      return Effect.die(`Unexpected API path: ${request.path}`);
    });
    const provider = yield* Provider.make;
    const result = yield* provider.getDiff({ ...input, cursor: "1" });
    expect(result.truncated).toBe(false);
    expect(result.patch).toContain("old mode 100644\nnew mode 100755");
    expect(result.patch).toContain("old mode 100644\nnew mode 120000");
    expect(result.patch).toContain("-Subproject commit old-commit\n+Subproject commit new-commit");
    expect(result.omittedFileStats).toBeUndefined();
  }).pipe(Effect.provide(runtime)),
);

it.effect("preserves authentication and rate-limit errors while rebuilding file previews", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.make;
    for (const reason of ["authentication", "rate-limit"] as const) {
      api.mockImplementation((request) => {
        if (request.path.endsWith("/pulls/1")) return json(pull);
        if (request.path.includes("/files?"))
          return json([{ filename: "added", status: "added", additions: 1, deletions: 0 }]);
        if (request.path.includes("/git/trees/"))
          return json({ truncated: false, tree: [{ path: "added", mode: "100644", sha: "blob" }] });
        return Effect.fail(
          new ForgejoCliError({ command: "fj", cwd: input.cwd, reason, detail: reason }),
        );
      });
      const error = yield* Effect.flip(provider.getDiff({ ...input, cursor: "1" }));
      expect(error.reason).toBe(reason === "authentication" ? "unauthenticated" : "rate-limited");
      expect(error.detail).toBe(reason);
    }
  }).pipe(Effect.provide(runtime)),
);
