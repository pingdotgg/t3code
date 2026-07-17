import type { SourceControlCapability } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitHubCli from "../../sourceControl/GitHubCli.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import type { PluginWorkspaceGrants } from "../PluginWorkspaceGrants.ts";

// Source-control ops take plugin-supplied `cwd` (which repo to operate on) and
// `createPullRequest` a `bodyFile` (read into the PR body). Both are DATA a
// well-behaved plugin may accept from a webhook/UI, so both must be contained:
// an unchecked `cwd` runs git/gh against an arbitrary repo, and an unchecked
// `bodyFile: "/path/to/secret"` exfiltrates arbitrary local file contents into
// the PR body. Require each to resolve within the plugin's granted workspace
// roots, mirroring the filesystem capability's real-path containment.
export class SourceControlPathError extends Schema.TaggedErrorClass<SourceControlPathError>()(
  "SourceControlPathError",
  { path: Schema.String, purpose: Schema.String },
) {
  override get message(): string {
    return `Source-control ${this.purpose} path ${JSON.stringify(this.path)} is outside the plugin's granted workspace roots.`;
  }
}

export function makeSourceControlCapability(input: {
  readonly registry: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"];
  readonly github: GitHubCli.GitHubCli["Service"];
  readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly grants: PluginWorkspaceGrants;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}): SourceControlCapability {
  const { path } = input;

  const contains = (realRoot: string, realTarget: string): boolean => {
    const relative = path.relative(realRoot, realTarget);
    // NOT `relative.startsWith("..")`: that also matches legitimate in-root names
    // that merely BEGIN with two dots — `..cache`, `..config` — which realPath had
    // already confirmed are inside the granted root. Only an exact ".." or a leading
    // "../" segment means the target escaped.
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const assertWithinGrants = (value: string, purpose: string): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const shell = yield* input.snapshots.getShellSnapshot();
      const projectRoots = shell.projects.map((project) => project.workspaceRoot);
      const grantedRoots = [...new Set([...projectRoots, ...(yield* input.grants.snapshot())])];
      // Real-path the target (also asserts it exists) and each granted root, so
      // symlinks/`..` cannot dodge the containment check.
      const realTarget = yield* input.fileSystem
        .realPath(value)
        .pipe(Effect.mapError(() => new SourceControlPathError({ path: value, purpose })));
      for (const root of grantedRoots) {
        const realRoot = yield* input.fileSystem.realPath(root).pipe(Effect.option);
        if (Option.isSome(realRoot) && contains(realRoot.value, realTarget)) {
          return;
        }
      }
      return yield* new SourceControlPathError({ path: value, purpose });
    });

  const withCwd = <A>(cwd: string, effect: Effect.Effect<A, Error>): Effect.Effect<A, Error> =>
    assertWithinGrants(cwd, "cwd").pipe(Effect.andThen(effect));

  return {
    detectProvider: ({ cwd }) =>
      withCwd(
        cwd,
        input.registry.resolveHandle({ cwd }).pipe(
          Effect.map((handle) => ({
            provider: handle.context?.provider ?? null,
            remoteName: handle.context?.remoteName ?? null,
            remoteUrl: handle.context?.remoteUrl ?? null,
          })),
        ),
      ),
    discoverProviders: input.registry.discover,
    listOpenPullRequests: (request) =>
      withCwd(request.cwd, input.github.listOpenPullRequests(request)),
    getPullRequest: (request) => withCwd(request.cwd, input.github.getPullRequest(request)),
    getRepositoryCloneUrls: (request) =>
      withCwd(request.cwd, input.github.getRepositoryCloneUrls(request)),
    createPullRequest: (request) =>
      Effect.gen(function* () {
        yield* assertWithinGrants(request.cwd, "cwd");
        // `gh` runs with `request.cwd` as its working directory, so a relative
        // bodyFile must be validated (and passed) as resolved against that cwd —
        // not the server process cwd — or containment checks the wrong file and
        // `gh` may read a different path than the one we just authorized.
        const bodyFile = path.isAbsolute(request.bodyFile)
          ? request.bodyFile
          : path.resolve(request.cwd, request.bodyFile);
        yield* assertWithinGrants(bodyFile, "bodyFile");
        return yield* input.github.createPullRequest({
          cwd: request.cwd,
          baseBranch: request.baseBranch,
          headSelector: request.headSelector,
          title: request.title,
          bodyFile,
          ...(request.draft === undefined ? {} : { draft: request.draft }),
        });
      }),
    mergePullRequest: (request) => withCwd(request.cwd, input.github.mergePullRequest(request)),
    getPullRequestDetail: (request) =>
      withCwd(request.cwd, input.github.getPullRequestDetail(request)),
    listPullRequestChecks: (request) =>
      withCwd(request.cwd, input.github.listPullRequestChecks(request)),
    listPullRequestReviews: (request) =>
      withCwd(request.cwd, input.github.listPullRequestReviews(request)),
    listPullRequestReviewComments: (request) =>
      withCwd(request.cwd, input.github.listPullRequestReviewComments(request)),
    getDefaultBranch: (request) => withCwd(request.cwd, input.github.getDefaultBranch(request)),
    checkoutPullRequest: (request) =>
      withCwd(request.cwd, input.github.checkoutPullRequest(request)),
  };
}
