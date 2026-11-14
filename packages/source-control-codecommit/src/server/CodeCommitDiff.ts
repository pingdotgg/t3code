import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import type { ProviderRepositoryRef } from "@t3tools/source-control-core/server/PullRequestProvider";
import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { structuredPatch } from "diff";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parseCodeCommitRemote } from "../shared/definition.ts";
import * as CodeCommitCli from "./CodeCommitCli.ts";

export interface CodeCommitSnapshot {
  readonly sourceCommit: string;
  readonly destinationCommit: string;
  readonly mergeBase: string;
  readonly sourceBranch: string;
  readonly destinationBranch: string;
}
type Input = ProviderRepositoryRef & {
  readonly number: number;
  readonly snapshot: CodeCommitSnapshot;
};
const blob = Schema.Struct({
  blobId: Schema.String,
  path: Schema.String,
  mode: Schema.optional(Schema.String),
});
const differences = Schema.Struct({
  differences: Schema.optional(
    Schema.Array(
      Schema.Struct({
        beforeBlob: Schema.optional(blob),
        afterBlob: Schema.optional(blob),
        changeType: Schema.String,
      }),
    ),
  ),
  NextToken: Schema.optional(Schema.String),
});
const blobResponse = Schema.Struct({ content: Schema.String });
const commitResponse = Schema.Struct({
  commit: Schema.Struct({
    commitId: Schema.String,
    parents: Schema.optional(Schema.Array(Schema.String)),
    message: Schema.optional(Schema.String),
    committer: Schema.optional(Schema.Struct({ date: Schema.optional(Schema.String) })),
    author: Schema.optional(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        email: Schema.optional(Schema.String),
      }),
    ),
  }),
});
type Change = NonNullable<Schema.Schema.Type<typeof differences>["differences"]>[number];
const MAX_FILES = 1000;
const PAGE_SIZE = 100;
const MAX_BYTES = 512 * 1024;
const SLICE_BYTES = 256 * 1024;
const MAX_EDITS = 2000;
const commitDate = (raw: string) => {
  const seconds = Number(raw.split(" ")[0]);
  const parsed = DateTime.make(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : raw);
  return Option.match(parsed, {
    onNone: () => "1970-01-01T00:00:00.000Z",
    onSome: DateTime.formatIso,
  });
};
const pathOf = (c: Change) => c.afterBlob?.path ?? c.beforeBlob?.path ?? "";
const sides = (c: Change) => ({
  oldPath: c.beforeBlob?.path ?? pathOf(c),
  newPath: c.afterBlob?.path ?? pathOf(c),
});

export const make = Effect.gen(function* () {
  const cli = yield* CodeCommitCli.make;
  const host = yield* SourceControlHost.SourceControlHost;
  const repository = (input: Input) => input.repository.split("/").at(-1) ?? "";
  const request = Effect.fn("CodeCommitDiff.request")(function* <A, I>(
    input: Input,
    args: string[],
    schema: Schema.Codec<A, I, never, never>,
  ) {
    const remote = parseCodeCommitRemote(`https://${input.host}/${input.repository}`);
    if (!remote)
      return yield* new CodeCommitCli.CodeCommitError({
        reason: "Invalid CodeCommit repository",
      });
    return yield* cli.request(input.cwd, ["codecommit", ...args], schema, remote.region);
  });
  const commit = (input: Input, id: string) =>
    request(
      input,
      ["get-commit", "--repository-name", repository(input), "--commit-id", id],
      commitResponse,
    );
  const history = Effect.fn("CodeCommitDiff.history")(function* (input: Input) {
    const base = input.snapshot.mergeBase || input.snapshot.destinationCommit;
    const source = input.snapshot.sourceCommit;
    if (base === source) return { candidates: [], truncated: false };
    const sha = /^[0-9a-f]{40}$/i;
    if (!sha.test(base) || !sha.test(source))
      return yield* new CodeCommitCli.CodeCommitError({ reason: "Invalid pull request commit ID" });
    const git = yield* Effect.gen(function* () {
      const shallow = yield* host.git.execute({
        operation: "CodeCommitDiff.shallow",
        cwd: input.cwd,
        args: ["rev-parse", "--is-shallow-repository"],
      });
      if (shallow.stdout.trim() !== "false" || shallow.stdoutTruncated) return null;
      const log = yield* host.git.execute({
        operation: "CodeCommitDiff.history",
        cwd: input.cwd,
        args: [
          "--no-replace-objects",
          "log",
          "--max-count=101",
          "--format=%H%x00%P%x00%cI%x00%s",
          source,
          `^${base}`,
          "--",
        ],
        maxOutputBytes: 1_000_000,
      });
      if (log.stdoutTruncated) return null;
      const rows = log.stdout.trimEnd().split("\n").filter(Boolean);
      const entries = rows.map((row) => {
        const [commitId, parents, date, message, ...extra] = row.split("\0");
        if (
          !commitId ||
          !sha.test(commitId) ||
          parents === undefined ||
          !date ||
          message === undefined ||
          extra.length ||
          (parents && !parents.split(" ").every((parent) => sha.test(parent)))
        )
          return null;
        return {
          commitId,
          parents: parents ? parents.split(" ") : [],
          message,
          committer: { date },
        };
      });
      if (entries.some((entry) => entry === null)) return null;
      return {
        candidates: entries.filter((entry) => entry !== null).slice(0, 100),
        truncated: rows.length > 100,
      };
    }).pipe(Effect.orElseSucceed(() => null));
    if (git !== null) return git;
    const head = (yield* commit(input, source)).commit;
    return { candidates: [head], truncated: true };
  });
  const range = Effect.fn("CodeCommitDiff.range")(function* (
    input: Input & { readonly commit?: string | undefined },
  ) {
    if (!input.commit)
      return {
        before: input.snapshot.mergeBase || input.snapshot.destinationCommit,
        after: input.snapshot.sourceCommit,
      };
    const entries = yield* history(input);
    const result = entries.candidates.find((candidate) => candidate.commitId === input.commit);
    if (!result)
      return yield* new CodeCommitCli.CodeCommitError({
        reason: "Commit is not in the pull request history",
      });
    if (!result.parents?.[0])
      return yield* new CodeCommitCli.CodeCommitError({ reason: "Cannot diff a root commit" });
    return { before: result.parents[0], after: result.commitId };
  });
  const list = Effect.fn("CodeCommitDiff.list")(function* (
    input: Input,
    before: string,
    after: string,
  ) {
    const changes: Change[] = [];
    let token: string | undefined;
    let truncated = false;
    let pages = 0;
    do {
      const previous = token;
      pages++;
      const page = yield* request(
        input,
        [
          "get-differences",
          "--repository-name",
          repository(input),
          "--before-commit-specifier",
          before,
          "--after-commit-specifier",
          after,
          "--max-items",
          String(PAGE_SIZE),
          ...(token ? ["--starting-token", token] : []),
        ],
        differences,
      );
      changes.push(...(page.differences ?? []));
      token = page.NextToken;
      if (changes.length >= MAX_FILES || pages >= 20 || (token && token === previous)) {
        truncated = !!token;
        break;
      }
    } while (token);
    return { changes: changes.slice(0, MAX_FILES), truncated };
  });
  const read = Effect.fn("CodeCommitDiff.readBlob")(function* (
    input: Input,
    id: string | undefined,
  ) {
    if (!id) return { contents: "", binary: false, oversized: false };
    if (/^[0-9a-f]{40}$/iu.test(id)) {
      const local = yield* host.git
        .execute({
          operation: "CodeCommitDiff.readBlob",
          cwd: input.cwd,
          args: ["--no-replace-objects", "cat-file", "blob", id],
          maxOutputBytes: MAX_BYTES,
          appendTruncationMarker: false,
        })
        .pipe(Effect.option);
      if (Option.isSome(local) && local.value.exitCode === 0)
        return {
          contents: local.value.stdout,
          binary: local.value.stdout.includes("\0") || local.value.stdout.includes("\ufffd"),
          oversized:
            local.value.stdoutTruncated || Buffer.byteLength(local.value.stdout) > MAX_BYTES,
        };
    }
    const result = yield* request(
      input,
      ["get-blob", "--repository-name", repository(input), "--blob-id", id],
      blobResponse,
    ).pipe(
      Effect.catchTags({
        CodeCommitError: (error) =>
          error.reason === "AWS CLI response exceeded output limit"
            ? Effect.succeed(null)
            : Effect.fail(error),
      }),
    );
    if (result === null) return { contents: "", binary: false, oversized: true };
    const bytes = Buffer.from(result.content, "base64");
    const contents = bytes.toString("utf8");
    return {
      contents,
      binary: bytes.includes(0) || !Buffer.from(contents).equals(bytes),
      oversized: bytes.length > MAX_BYTES,
    };
  });
  const texts = Effect.fn("CodeCommitDiff.texts")(function* (input: Input, change: Change) {
    const [old, current] = yield* Effect.all(
      [read(input, change.beforeBlob?.blobId), read(input, change.afterBlob?.blobId)],
      { concurrency: 2 },
    );
    return {
      oldContents: old.contents,
      newContents: current.contents,
      binary: old.binary || current.binary,
      oversized: old.oversized || current.oversized,
    };
  });
  const patch = (
    change: Change,
    content: { oldContents: string; newContents: string; binary: boolean; oversized: boolean },
  ) => {
    const paths = sides(change);
    const oldPath = quoteGitPatchPath(`a/${paths.oldPath}`);
    const newPath = quoteGitPatchPath(`b/${paths.newPath}`);
    const header = [`diff --git ${oldPath} ${newPath}`];
    if (!change.beforeBlob) header.push(`new file mode ${change.afterBlob?.mode ?? "100644"}`);
    else if (!change.afterBlob)
      header.push(`deleted file mode ${change.beforeBlob.mode ?? "100644"}`);
    else if (
      change.beforeBlob.mode !== change.afterBlob.mode &&
      change.beforeBlob.mode &&
      change.afterBlob.mode
    )
      header.push(`old mode ${change.beforeBlob.mode}`, `new mode ${change.afterBlob.mode}`);
    if (paths.oldPath !== paths.newPath)
      header.push(
        `similarity index ${change.beforeBlob?.blobId === change.afterBlob?.blobId ? 100 : 0}%`,
        `rename from ${quoteGitPatchPath(paths.oldPath)}`,
        `rename to ${quoteGitPatchPath(paths.newPath)}`,
      );
    header.push(
      `--- ${change.beforeBlob ? oldPath : "/dev/null"}`,
      `+++ ${change.afterBlob ? newPath : "/dev/null"}`,
    );
    if (content.binary)
      return {
        section: `${header.join("\n")}\nBinary files ${oldPath} and ${newPath} differ\n`,
        truncated: true,
        additions: 0,
        deletions: 0,
      };
    if (content.oversized)
      return { section: `${header.join("\n")}\n`, truncated: true, additions: 0, deletions: 0 };
    const diff = structuredPatch(
      paths.oldPath,
      paths.newPath,
      content.oldContents,
      content.newContents,
      undefined,
      undefined,
      { context: 3, maxEditLength: MAX_EDITS, timeout: 2000 },
    );
    if (!diff)
      return { section: `${header.join("\n")}\n`, truncated: true, additions: 0, deletions: 0 };
    let additions = 0,
      deletions = 0;
    const hunks = diff.hunks.map((h) => {
      for (const line of h.lines) {
        if (line.startsWith("+")) additions++;
        else if (line.startsWith("-")) deletions++;
      }
      const range = (start: number, count: number) =>
        count === 0 ? `${start - 1},0` : count === 1 ? String(start) : `${start},${count}`;
      return [
        `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`,
        ...h.lines,
      ].join("\n");
    });
    const section = `${[...header, ...hunks].join("\n")}\n`;
    return Buffer.byteLength(section) > MAX_BYTES
      ? { section: `${header.join("\n")}\n`, truncated: true, additions, deletions }
      : { section, truncated: false, additions, deletions };
  };
  const indexed = Effect.fn("CodeCommitDiff.indexed")(function* (
    input: Input & { readonly commit?: string | undefined; readonly cursor?: string | undefined },
  ) {
    const selected = yield* range(input);
    const parts = input.cursor?.split(":");
    if (
      parts &&
      (parts.length !== 3 ||
        parts[0] !== selected.before ||
        parts[1] !== selected.after ||
        !/^\d+$/.test(parts[2] ?? ""))
    )
      return yield* new CodeCommitCli.CodeCommitError({
        reason: "Diff cursor is invalid or the pull request changed",
      });
    const offset = parts ? Number(parts[2]) : 0;
    if (!Number.isSafeInteger(offset) || offset > MAX_FILES)
      return yield* new CodeCommitCli.CodeCommitError({ reason: "Invalid diff cursor" });
    const listed = yield* list(input, selected.before, selected.after);
    return {
      ...listed,
      offset,
      cursor: (index: number) =>
        index < listed.changes.length ? `${selected.before}:${selected.after}:${index}` : null,
    };
  });
  const getDiff = Effect.fn("CodeCommitDiff.getDiff")(function* (
    input: Input & { readonly commit?: string | undefined; readonly cursor?: string | undefined },
  ) {
    const indexedChanges = yield* indexed(input);
    let index = indexedChanges.offset,
      bytes = 0,
      truncated = indexedChanges.truncated;
    const sections: string[] = [];
    while (index < indexedChanges.changes.length && sections.length < 100 && bytes < SLICE_BYTES) {
      const change = indexedChanges.changes[index]!;
      const result = patch(change, yield* texts(input, change));
      sections.push(result.section);
      bytes += Buffer.byteLength(result.section);
      truncated ||= result.truncated;
      index++;
      yield* Effect.yieldNow;
    }
    return { patch: sections.join(""), truncated, nextCursor: indexedChanges.cursor(index) };
  });
  const getDiffFilePaths = Effect.fn("CodeCommitDiff.getDiffFilePaths")(function* (
    input: Input & { readonly commit?: string | undefined; readonly cursor?: string | undefined },
  ) {
    const result = yield* indexed(input);
    const end = Math.min(result.offset + PAGE_SIZE, result.changes.length);
    return {
      files: result.changes.slice(result.offset, end).map(sides),
      nextCursor: result.cursor(end),
    };
  });
  const getDiffFileContents = Effect.fn("CodeCommitDiff.getDiffFileContents")(function* (
    input: Input & {
      readonly commit?: string | undefined;
      readonly oldPath: string;
      readonly newPath: string;
      readonly changeType: string;
    },
  ) {
    const selected = yield* range(input);
    const result = yield* list(input, selected.before, selected.after);
    const found = result.changes.find(
      (c) => sides(c).oldPath === input.oldPath && sides(c).newPath === input.newPath,
    );
    if (!found) return yield* new CodeCommitCli.CodeCommitError({ reason: "Diff file not found" });
    const content = yield* texts(input, found);
    if (content.binary || content.oversized)
      return yield* new CodeCommitCli.CodeCommitError({
        reason: "Diff file is binary or too large",
      });
    return { oldContents: content.oldContents, newContents: content.newContents };
  });
  const getFileStats = Effect.fn("CodeCommitDiff.getFileStats")(function* (input: Input) {
    const selected = yield* range(input);
    const result = yield* list(input, selected.before, selected.after);
    const files: { path: string; additions: number; deletions: number }[] = [];
    let truncated = result.truncated || result.changes.length > 100;
    for (const change of result.changes.slice(0, 100)) {
      const contents = yield* texts(input, change);
      const entry = patch(change, contents);
      if (entry.truncated) truncated = true;
      else
        files.push({
          path: pathOf(change),
          additions: entry.additions,
          deletions: entry.deletions,
        });
      yield* Effect.yieldNow;
    }
    return { files, truncated };
  });
  const getDetailStats = Effect.fn("CodeCommitDiff.getDetailStats")(function* (input: Input) {
    const selected = yield* range(input);
    const listed = yield* list(input, selected.before, selected.after);
    const stats = yield* getFileStats(input);
    return {
      changedFiles: listed.changes.length,
      additions: stats.files.reduce((n, f) => n + f.additions, 0),
      deletions: stats.files.reduce((n, f) => n + f.deletions, 0),
      truncated: stats.truncated,
    };
  });
  const getFileRevisions = Effect.fn("CodeCommitDiff.getFileRevisions")(function* (
    input: Input & { readonly paths: ReadonlyArray<string> },
  ) {
    const selected = yield* range(input);
    const result = yield* list(input, selected.before, selected.after);
    const wanted = new Set(input.paths);
    const revisions = new Map<string, string>();
    for (const change of result.changes)
      if (wanted.has(pathOf(change))) revisions.set(pathOf(change), change.afterBlob?.blobId ?? "");
    if (!result.truncated)
      for (const path of input.paths) if (!revisions.has(path)) revisions.set(path, "");
    return { revisions, complete: !result.truncated };
  });
  const getCommits = Effect.fn("CodeCommitDiff.getCommits")(function* (input: Input) {
    const result = yield* history(input);
    return {
      commits: result.candidates.map((entry) => ({
        oid: entry.commitId,
        messageHeadline: (entry.message ?? "").split("\n")[0] ?? "",
        committedDate: commitDate(entry.committer?.date ?? ""),
      })),
      truncated: result.truncated,
    };
  });
  return {
    getDiff,
    getDiffFilePaths,
    getDiffFileContents,
    getFileStats,
    getFileRevisions,
    getDetailStats,
    getCommits,
  };
});
