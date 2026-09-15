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
        if (request.path.includes("/contents/")) {
          const text = request.path.includes("binary.bin")
            ? "\0binary"
            : request.path.endsWith("ref=head")
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
      expect(first.patch).toContain('deleted file mode 100644\n--- "a/deleted.ts"\n+++ /dev/null');
      expect(first.patch).toContain("Binary files differ");
      expect(first.omittedFileStats).toContainEqual({
        path: " new.ts",
        additions: 1,
        deletions: 1,
      });
      const last = yield* provider.getDiff({ ...input, cursor: "2" });
      expect(last.nextCursor).toBeNull();
      expect(last.patch).toBe("");
      expect(api.mock.calls.filter(([request]) => request.path.endsWith(".diff"))).toHaveLength(1);
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
