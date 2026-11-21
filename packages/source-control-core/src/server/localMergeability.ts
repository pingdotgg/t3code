import type { PullRequestMergeability } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type * as SourceControlHost from "./SourceControlHost.ts";

/** Where to fetch a pull request's commits from when the checkout lacks them. */
export interface LocalMergeabilityFetchSource {
  /** A remote URL the checkout already uses, so git reuses its credentials. */
  readonly url: string;
  /** Refs that hold the base and head commits, such as `refs/pull/7/head`. */
  readonly refs: ReadonlyArray<string>;
}

export interface LocalMergeabilityInput {
  readonly cwd: string;
  readonly baseSha: string;
  readonly headSha: string;
  /**
   * Resolved only when a commit is missing from the checkout. Undefined leaves the answer
   * unknown, which keeps a checkout of another repository from being fetched into.
   */
  readonly fetchSource?: Effect.Effect<LocalMergeabilityFetchSource | undefined> | undefined;
}

type Process = SourceControlHost.SourceControlHost["Service"]["process"];

const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const LOOKUP_TIMEOUT_MS = 5_000;
const MERGE_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 30_000;
const CACHE_LIMIT = 256;
/** How long a failed fetch keeps a pair unknown before it is tried again. */
const RETRY_AFTER_MS = 5 * 60_000;
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" } as const;

const isGitRef = (ref: string) =>
  ref.length > 0 && !ref.startsWith("-") && !/[\s\0:^~?*[\\]|\.\.|@\{/.test(ref);

/**
 * Merges a pull request's base and head commits in the local checkout, for hosts whose API cannot
 * tell a conflict from a pending check. `merge-tree --write-tree` leaves worktree, index and refs
 * alone; any failure, including a git before 2.38, reads as "unknown". Answers are cached per pair.
 */
export function makeLocalMergeabilityReader(process: Process) {
  const cache = new Map<
    string,
    {
      readonly value: PullRequestMergeability;
      readonly until: number;
      readonly unfetched: boolean;
    }
  >();
  const remember = (
    key: string,
    value: PullRequestMergeability,
    until: number,
    unfetched = false,
  ) => {
    cache.delete(key);
    cache.set(key, { value, until, unfetched });
    const oldest = cache.keys().next();
    if (cache.size > CACHE_LIMIT && !oldest.done) cache.delete(oldest.value);
  };
  const git = (
    input: LocalMergeabilityInput,
    operation: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
  ) =>
    process
      .run({
        operation: `localMergeability.${operation}`,
        command: "git",
        cwd: input.cwd,
        args,
        env: GIT_ENV,
        allowNonZeroExit: true,
        timeoutMs,
        maxOutputBytes: 4_096,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((output) => output.exitCode),
        Effect.orElseSucceed(() => -1),
      );
  const hasCommits = (input: LocalMergeabilityInput) =>
    git(
      input,
      "hasCommits",
      ["cat-file", "-e", `${input.baseSha}^{commit}`],
      LOOKUP_TIMEOUT_MS,
    ).pipe(
      Effect.flatMap((base) =>
        base === 0
          ? git(
              input,
              "hasCommits",
              ["cat-file", "-e", `${input.headSha}^{commit}`],
              LOOKUP_TIMEOUT_MS,
            ).pipe(Effect.map((head) => head === 0))
          : Effect.succeed(false),
      ),
    );
  const fetch = Effect.fn("localMergeability.fetch")(function* (input: LocalMergeabilityInput) {
    const source = input.fetchSource ? yield* input.fetchSource : undefined;
    const refs = source?.refs.filter(isGitRef) ?? [];
    if (!source || source.url.startsWith("-") || refs.length === 0) return false;
    const exitCode = yield* git(
      input,
      "fetch",
      // No destination refspec and no FETCH_HEAD: only objects land in the checkout.
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        "--no-recurse-submodules",
        "--",
        source.url,
        ...refs,
      ],
      FETCH_TIMEOUT_MS,
    );
    return exitCode === 0 && (yield* hasCommits(input));
  });

  return Effect.fn("localMergeability.read")(function* (input: LocalMergeabilityInput) {
    if (!COMMIT_SHA.test(input.baseSha) || !COMMIT_SHA.test(input.headSha)) return "unknown";
    const key = `${input.cwd}\0${input.baseSha.toLowerCase()}\0${input.headSha.toLowerCase()}`;
    const now = yield* Clock.currentTimeMillis;
    const cached = cache.get(key);
    // A miss from a read that could not fetch must not stop one that can.
    if (cached && cached.until > now && !(cached.unfetched && input.fetchSource)) {
      return cached.value;
    }

    const present = (yield* hasCommits(input)) || (yield* fetch(input));
    if (!present) {
      remember(key, "unknown", now + RETRY_AFTER_MS, !input.fetchSource);
      return "unknown";
    }
    const exitCode = yield* git(
      input,
      "merge",
      // Not `--quiet`: git 2.56 exits 0 with it on pairs that do conflict.
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", input.baseSha, input.headSha],
      MERGE_TIMEOUT_MS,
    );
    const value: PullRequestMergeability =
      exitCode === 0 ? "mergeable" : exitCode === 1 ? "conflicting" : "unknown";
    // An unknown merge result usually means an older git; retrying it every read is wasted work.
    remember(key, value, value === "unknown" ? now + RETRY_AFTER_MS : Number.POSITIVE_INFINITY);
    return value;
  });
}

export type LocalMergeabilityReader = ReturnType<typeof makeLocalMergeabilityReader>;
