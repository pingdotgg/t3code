import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";

import { spawnAndCollect } from "./providerSnapshot.ts";

class CursorCloudWorkspaceError extends Schema.TaggedError<CursorCloudWorkspaceError>()(
  "CursorCloudWorkspaceError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

interface CursorCloudRepository {
  /** `https://github.com/<owner>/<repo>`, the form the API accepts. */
  readonly url: string;
  /** A branch on the remote, or a commit SHA when inferred from a checkout off any tip. */
  readonly startingRef: string;
  /** The checkout has work on the starting branch that the cloud agent will not see. */
  readonly hasUnpushedLocalWork: boolean;
}

/**
 * Resolve where a cloud agent starts. The agent clones from GitHub, so the
 * starting point must already be there; anything else would silently start
 * from different code. `selectedBranch` is the thread's chosen branch; without
 * one, the local checkout's position decides.
 */
export const resolveCursorCloudRepository = Effect.fn("resolveCursorCloudRepository")(function* (
  cwd: string,
  selectedBranch?: string,
  env?: NodeJS.ProcessEnv,
) {
  const git = (args: ReadonlyArray<string>) =>
    spawnAndCollect("git", ChildProcess.make("git", args, { cwd, ...(env ? { env } : {}) })).pipe(
      Effect.map((result) => (result.code === 0 ? result.stdout.trim() : undefined)),
      Effect.mapError(
        (cause) => new CursorCloudWorkspaceError({ detail: "Could not run git.", cause }),
      ),
    );

  const head = yield* git(["rev-parse", "HEAD"]);
  if (!head) {
    return yield* new CursorCloudWorkspaceError({
      detail: "Cursor Cloud needs a git repository with at least one commit.",
    });
  }

  const checkedOut = yield* git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const localBranch = selectedBranch
    ? yield* git(["rev-parse", "--verify", "--quiet", `refs/heads/${selectedBranch}`])
    : undefined;
  const remotes = (yield* git(["remote"]))?.split("\n") ?? [];
  const selectedRemote =
    localBranch === undefined && selectedBranch
      ? remotes
          .sort((a, b) => b.length - a.length)
          .find((name) => selectedBranch.startsWith(`${name}/`))
      : undefined;
  const branch = selectedRemote ? undefined : (selectedBranch ?? checkedOut);
  const trackedRemote = branch ? yield* git(["config", `branch.${branch}.remote`]) : undefined;
  const remote =
    selectedRemote ?? (trackedRemote && trackedRemote !== "." ? trackedRemote : "origin");
  const remoteUrl = yield* git(["remote", "get-url", remote]);
  const nameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl ?? null);
  if (!nameWithOwner) {
    return yield* new CursorCloudWorkspaceError({
      detail: remoteUrl
        ? `Cursor Cloud only works with GitHub repositories, and remote '${remote}' is not on GitHub.`
        : `Cursor Cloud needs a GitHub remote named '${remote}'.`,
    });
  }

  const mergeRef = branch ? yield* git(["config", `branch.${branch}.merge`]) : undefined;
  // The branch picker can hand over a remote ref such as `origin/feature`.
  const remoteQualified =
    selectedRemote && selectedBranch ? selectedBranch.slice(selectedRemote.length + 1) : undefined;
  const upstreamBranch = mergeRef?.startsWith("refs/heads/")
    ? mergeRef.slice("refs/heads/".length)
    : (remoteQualified ?? selectedBranch);
  const upstreamTip = upstreamBranch
    ? yield* git(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${upstreamBranch}`])
    : undefined;
  const status = yield* git(["status", "--porcelain", "--untracked-files=no"]);
  const dirty = (status ?? "").length > 0;

  if (selectedBranch !== undefined) {
    if (!upstreamBranch || !upstreamTip) {
      return yield* new CursorCloudWorkspaceError({
        detail: `Branch '${selectedBranch}' is not on GitHub yet. Push it, or pick a branch that is.`,
      });
    }
    const localRefs = selectedRemote
      ? (
          (yield* git(["for-each-ref", "--format=%(refname:short)\t%(upstream)", "refs/heads/"])) ??
          ""
        )
          .split("\n")
          .flatMap((line) => {
            const [name, upstream] = line.split("\t");
            return name && upstream === `refs/remotes/${remote}/${upstreamBranch}` ? [name] : [];
          })
      : localBranch
        ? [selectedBranch]
        : [];
    let hasUnpushedLocalWork = false;
    for (const name of localRefs) {
      const ahead = yield* git(["rev-list", "--count", `${upstreamTip}..refs/heads/${name}`]);
      if ((name === checkedOut && dirty) || Number(ahead ?? 0) > 0) {
        hasUnpushedLocalWork = true;
        break;
      }
    }
    return {
      url: `https://github.com/${nameWithOwner}`,
      startingRef: upstreamBranch,
      hasUnpushedLocalWork,
    } satisfies CursorCloudRepository;
  }

  let startingRef: string;
  if (upstreamBranch && upstreamTip === head) {
    startingRef = upstreamBranch;
  } else {
    const containing = yield* git([
      "for-each-ref",
      "--contains",
      head,
      "--count=1",
      "--format=%(refname)",
      `refs/remotes/${remote}/`,
    ]);
    if (!containing) {
      return yield* new CursorCloudWorkspaceError({
        detail: `Commit ${head.slice(0, 7)} is not on GitHub yet. Push it, then send your message again.`,
      });
    }
    startingRef = head;
  }

  return {
    url: `https://github.com/${nameWithOwner}`,
    startingRef,
    hasUnpushedLocalWork: dirty,
  } satisfies CursorCloudRepository;
});
