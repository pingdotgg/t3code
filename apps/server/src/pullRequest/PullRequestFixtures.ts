/**
 * Recorded GitHub change requests for `vp run stress` (see apps/web/stress/README.md):
 * `T3CODE_PR_FIXTURES=<dir>` serves reads from calls/, and diffs from a bare clone in repos/ since
 * the API truncates them; `T3CODE_PR_FIXTURES_RECORD=1` saves what the real host answers instead.
 */
import type { SourceControlProviderKind } from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderDiffSlice,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const fixturesConfig = Config.all({
  dir: Config.String("T3CODE_PR_FIXTURES").pipe(Config.option),
  record: Config.Boolean("T3CODE_PR_FIXTURES_RECORD").pipe(Config.withDefault(false)),
});

const RECORDED_READS = [
  "getViewer",
  "listChangeRequests",
  "listChangeRequestsAcross",
  "listChangeRequestStats",
  "getChangeRequestChecks",
  "getChangeRequest",
  "getChangeRequestPreview",
  "getChangeRequestSummary",
  "getChangeRequestWatchFingerprint",
  "getChangeRequestStack",
  "getChangeRequestActivity",
  "getReviewThreadComments",
  "getViewerPermissions",
  "getFilesViewed",
  "getFileRevisions",
  "listReviewerCandidates",
  "listLabelCandidates",
  "listRepositoryLabels",
  "searchRepositoryAuthors",
] as const satisfies ReadonlyArray<keyof PullRequestProviderApi>;

const DIFF_PAGE_FILES = 100;
const PATHS_PAGE_FILES = 1000;
const MAX_DIFF_BYTES = 2 * 1024 * 1024 * 1024;

const RecordedCall = Schema.Struct({ input: Schema.Unknown, result: Schema.Unknown });
const ChangeRevisions = Schema.Struct({ baseSha: Schema.String, headSha: Schema.String });
const decodeCall = Schema.decodeUnknownEffect(Schema.fromJsonString(RecordedCall));
const decodeRevisions = Schema.decodeUnknownEffect(Schema.fromJsonString(ChangeRevisions));

// Machine and account details differ between the recording and the replay.
const VOLATILE_INPUT_KEYS = new Set(["cwd", "host", "viewer"]);

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value)
    .filter(([key, entry]) => entry !== undefined && !VOLATILE_INPUT_KEYS.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableKey(entry)}`)
    .join(",")}}`;
}

/** FNV-1a; names files, so collisions only matter between reads of one fixture set. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}

const callFile = (method: string, input: unknown) => `${method}-${hash(stableKey(input))}.json`;
const repositorySlug = (repository: string) => repository.replace("/", "__");

/** Splits `git diff` output into one patch per file, keeping each file's header lines. */
export function splitPatch(patch: string): string[] {
  return patch.split(/^(?=diff --git )/m).filter((part) => part.startsWith("diff --git "));
}

/** The old and new path of one file's patch, from its `---`/`+++` lines or its header. */
export function patchPaths(filePatch: string): { oldPath: string; newPath: string } {
  const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(filePatch);
  const renameFrom = /^rename from (.+)$/m.exec(filePatch)?.[1];
  const renameTo = /^rename to (.+)$/m.exec(filePatch)?.[1];
  const oldPath = renameFrom ?? header?.[1] ?? "";
  const newPath = renameTo ?? header?.[2] ?? oldPath;
  return { oldPath, newPath };
}

/** `git diff --numstat -z`: a rename leaves its path empty and follows with old and new paths. */
export function parseNumstat(output: string) {
  const fields = output.split("\0");
  const files: Array<{ path: string; additions: number; deletions: number }> = [];
  for (let index = 0; index < fields.length; index++) {
    const [additions, deletions, path] = fields[index]!.split("\t");
    if (additions === undefined || deletions === undefined || path === undefined) continue;
    // Binary files report "-" for both counts.
    const counts = { additions: Number(additions) || 0, deletions: Number(deletions) || 0 };
    if (path === "") {
      files.push({ path: fields[index + 2] ?? "", ...counts });
      index += 2;
    } else {
      files.push({ path, ...counts });
    }
  }
  return files;
}

/** Wraps a real provider so each read it answers is also written to `dir`. */
const recordingProvider = Effect.fn("PullRequestFixtures.recordingProvider")(function* (
  provider: PullRequestProviderApi,
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const calls = path.join(dir, "calls");
  yield* fs.makeDirectory(calls, { recursive: true }).pipe(Effect.orDie);
  const wrapped: Record<string, unknown> = { ...provider };
  for (const method of RECORDED_READS) {
    const read = provider[method] as
      | ((input: unknown) => Effect.Effect<unknown, PullRequestProviderError>)
      | undefined;
    if (read === undefined) continue;
    wrapped[method] = (input: unknown) =>
      read(input).pipe(
        Effect.tap((result) =>
          fs
            .writeFileString(
              path.join(calls, callFile(method, input)),
              JSON.stringify({ input, result }),
            )
            .pipe(Effect.ignore),
        ),
      );
  }
  return wrapped as unknown as PullRequestProviderApi;
});

/** Serves `provider`'s kind from `dir` alone: recorded reads, diffs from the local clone. */
const replayProvider = Effect.fn("PullRequestFixtures.replayProvider")(function* (
  provider: PullRequestProviderApi,
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ProcessRunner.ProcessRunner;
  const kind: SourceControlProviderKind = provider.kind;

  const notRecorded = (operation: string, detail: string) =>
    new PullRequestProviderError({ provider: kind, operation, reason: "not-found", detail });

  const recorded = (method: string, input: unknown) =>
    fs.readFileString(path.join(dir, "calls", callFile(method, input))).pipe(
      Effect.flatMap(decodeCall),
      Effect.map((call) => call.result),
      Effect.mapError(() => notRecorded(method, `No recorded ${method} for this input.`)),
    );

  const git = (operation: string, repository: string, args: ReadonlyArray<string>) =>
    processes
      .run({
        command: "git",
        args: ["--git-dir", path.join(dir, "repos", `${repositorySlug(repository)}.git`), ...args],
        maxOutputBytes: MAX_DIFF_BYTES,
        timeout: "10 minutes",
      })
      .pipe(
        Effect.mapError((error) => notRecorded(operation, `git failed: ${error.message}`)),
        Effect.flatMap((output) =>
          output.code === 0
            ? Effect.succeed(output.stdout)
            : Effect.fail(notRecorded(operation, output.stderr.trim())),
        ),
      );

  const revisions = (repository: string, number: number) =>
    fs
      .readFileString(path.join(dir, "changes", `${repositorySlug(repository)}__${number}.json`))
      .pipe(
        Effect.flatMap(decodeRevisions),
        Effect.mapError(() =>
          notRecorded("getDiff", `No recorded revisions for ${repository}#${number}.`),
        ),
      );

  // One diff per change or commit, split once; the code tab pages through it many times.
  const filePatches = yield* Cache.make({
    capacity: 8,
    lookup: Effect.fn("PullRequestFixtures.filePatches")(function* (key: string) {
      const [repository, number, commit] = key.split("\u0000") as [string, string, string];
      if (commit) {
        return splitPatch(
          yield* git("getDiff", repository, ["show", "--no-color", "--format=", "-M", commit]),
        );
      }
      const { baseSha, headSha } = yield* revisions(repository, Number(number));
      return splitPatch(
        yield* git("getDiff", repository, ["diff", "--no-color", "-M", baseSha, headSha]),
      );
    }),
  });
  const patchesFor = (input: {
    readonly repository: string;
    readonly number: number;
    readonly commit?: string | undefined;
  }) =>
    Cache.get(filePatches, `${input.repository}\u0000${input.number}\u0000${input.commit ?? ""}`);

  const page = <A>(items: ReadonlyArray<A>, cursor: string | undefined, size: number) => {
    const start = cursor === undefined ? 0 : Number(cursor);
    const end = start + size;
    return { items: items.slice(start, end), nextCursor: end < items.length ? String(end) : null };
  };

  const fallbackViewer = "fixture";
  const viewer = recorded("getViewer", {}).pipe(
    Effect.map((value) => (typeof value === "string" ? value : fallbackViewer)),
    Effect.orElseSucceed(() => fallbackViewer),
  );

  const withVerifiedCredential: NonNullable<PullRequestProviderApi["withVerifiedCredential"]> = (
    _input,
    use,
  ) =>
    viewer.pipe(
      Effect.flatMap((name) =>
        use({ accountId: "fixture", viewer: name, credentialFingerprint: "fixture" }),
      ),
    );
  const getDiffFileContents: NonNullable<PullRequestProviderApi["getDiffFileContents"]> = Effect.fn(
    "PullRequestFixtures.getDiffFileContents",
  )(function* (input) {
    const { baseSha, headSha } = input.commit
      ? { baseSha: `${input.commit}^`, headSha: input.commit }
      : yield* revisions(input.repository, input.number);
    const show = (revision: string, file: string) =>
      git("getDiffFileContents", input.repository, ["show", `${revision}:${file}`]);
    return {
      oldContents: input.changeType === "new" ? "" : yield* show(baseSha, input.oldPath),
      newContents: input.changeType === "deleted" ? "" : yield* show(headSha, input.newPath),
    };
  });

  const replayed: Record<string, unknown> = {
    ...provider,
    withVerifiedCredential,
    getRoutingIdentity: () =>
      viewer.pipe(Effect.map((name) => ({ accountId: "fixture", viewer: name }))),
    getViewer: () => viewer,
    getDiff: (input: Parameters<PullRequestProviderApi["getDiff"]>[0]) =>
      patchesFor(input).pipe(
        Effect.map((patches): ProviderDiffSlice => {
          const { items, nextCursor } = page(patches, input.cursor, DIFF_PAGE_FILES);
          return { patch: items.join(""), truncated: false, nextCursor };
        }),
      ),
    getDiffFilePaths: (
      input: Parameters<NonNullable<PullRequestProviderApi["getDiffFilePaths"]>>[0],
    ) =>
      patchesFor(input).pipe(
        Effect.map((patches) => {
          const { items, nextCursor } = page(
            patches.map(patchPaths),
            input.cursor,
            PATHS_PAGE_FILES,
          );
          return { files: items, nextCursor };
        }),
      ),
    getFileStats: (input: Parameters<NonNullable<PullRequestProviderApi["getFileStats"]>>[0]) =>
      revisions(input.repository, input.number).pipe(
        Effect.flatMap(({ baseSha, headSha }) =>
          git("getFileStats", input.repository, [
            "diff",
            "--numstat",
            "-z",
            "-M",
            baseSha,
            headSha,
          ]),
        ),
        Effect.map((numstat) => ({ files: parseNumstat(numstat), truncated: false })),
      ),
    getDiffFileContents,
    getFilesViewed: (input: unknown) =>
      recorded("getFilesViewed", input).pipe(
        Effect.orElseSucceed(() => ({ files: [], truncated: false })),
      ),
    forgetChangeRequestReads: () => Effect.void,
    runAction: () => Effect.void,
    updateChangeRequest: () => Effect.void,
    comment: () => Effect.void,
    updateComment: () => Effect.void,
    submitReview: () => Effect.void,
    setReviewerRequest: () => Effect.void,
    setLabels: () => Effect.void,
    replyToThread: () => Effect.void,
    setReaction: () => Effect.void,
    setThreadResolution: () => Effect.void,
    setFilesViewed: () => Effect.void,
  };
  for (const method of RECORDED_READS) {
    if (method === "getViewer" || provider[method] === undefined) continue;
    replayed[method] = (input: unknown) => recorded(method, input);
  }
  return replayed as unknown as PullRequestProviderApi;
});

/** The fixture form of `provider` when the environment asks for one, else `provider` itself. */
export const applyFixtures = Effect.fn("PullRequestFixtures.applyFixtures")(function* (
  provider: PullRequestProviderApi,
) {
  const config = yield* fixturesConfig;
  const dir = Option.getOrUndefined(config.dir);
  if (dir === undefined || provider.kind !== "github") return provider;
  return config.record
    ? yield* recordingProvider(provider, dir)
    : yield* replayProvider(provider, dir);
});
