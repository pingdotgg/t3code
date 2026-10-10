import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { dedent } from "../Util/dedent.ts";
import { gitHubBaseUrlChanged, Octokit, octokitFor } from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";

export interface ReleaseProps {
  /**
   * Repository owner (user or organization).
   */
  owner: string;

  /**
   * Repository name.
   */
  repository: string;

  /**
   * Git tag name for this release. The tag is the release's identity —
   * changing it replaces the release.
   */
  tagName: string;

  /**
   * Release title/name. If omitted, GitHub uses the tag name.
   */
  name?: string;

  /**
   * Release notes/description (supports GitHub Markdown).
   *
   * The body is automatically dedented, so you can use indented template
   * literals without worrying about leading whitespace. Accepts
   * `Output<string>` at the call site via `Output.interpolate` to embed
   * resource attributes that are not yet resolved.
   */
  body?: string;

  /**
   * Whether this is a draft release (not visible to users).
   * @default false
   */
  draft?: boolean;

  /**
   * Whether this is a prerelease (beta, alpha, etc.).
   * @default false
   */
  prerelease?: boolean;

  /**
   * Commitish (branch, commit SHA, or tag) to target. If the tag doesn't
   * exist, the release will create it from this commitish. If omitted,
   * GitHub defaults to the repository's default branch.
   */
  targetCommitish?: string;

  /**
   * Whether to automatically generate release notes from commits.
   * @default false
   */
  generateReleaseNotes?: boolean;

  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise). Falls back to
   * `GitHub.providers({ baseUrl })`, then to the host resolved by the auth
   * provider. Changing it replaces the resource — the same name on a
   * different GitHub instance is a different physical resource.
   */
  baseUrl?: string;
}

export interface Release extends Resource<
  "GitHub.Release",
  ReleaseProps,
  {
    /**
     * Numeric release ID.
     */
    releaseId: number;

    /**
     * GraphQL node ID of the release.
     */
    nodeId: string;

    /**
     * The git tag name.
     */
    tagName: string;

    /**
     * The release name/title.
     */
    name: string;

    /**
     * Release notes/description.
     */
    body: string;

    /**
     * Whether this is a draft release.
     */
    draft: boolean;

    /**
     * Whether this is a prerelease.
     */
    prerelease: boolean;

    /**
     * URL to view the release in a browser.
     */
    htmlUrl: string;

    /**
     * URL for uploading release assets.
     */
    uploadUrl: string;

    /**
     * ISO-8601 timestamp of when the release was created.
     */
    createdAt: string;

    /**
     * ISO-8601 timestamp of when the release was published.
     */
    publishedAt: string | null;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub release.
 *
 * `Release` manages repository releases (tagged versions with notes,
 * binaries, etc.). Releases are created on first deploy and updated in place
 * on subsequent deploys when properties change. Publishing a draft converts it
 * to a public release.
 *
 * Authentication is resolved via the `GitHubCredentials` service supplied by
 * `GitHub.providers()` (env, stored PAT, `gh` CLI, or OAuth). The token needs
 * `repo` scope for private repositories or `public_repo` for public ones.
 * ### Creating Releases
 * **Example:** Basic Release
 * ```typescript
 * const v1 = yield* GitHub.Release("v1", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   tagName: "v1.0.0",
 *   name: "Version 1.0.0",
 *   body: "First stable release",
 * });
 * ```
 *
 * **Example:** Prerelease
 * ```typescript
 * yield* GitHub.Release("beta", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   tagName: "v2.0.0-beta.1",
 *   name: "v2.0.0 Beta 1",
 *   body: "Beta release for testing",
 *   prerelease: true,
 * });
 * ```
 *
 * ### Draft Releases
 * **Example:** Create Draft and Publish Later
 * ```typescript
 * // First deploy: create as draft
 * const release = yield* GitHub.Release("v1", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   tagName: "v1.0.0",
 *   name: "Version 1.0.0",
 *   body: "Release notes here",
 *   draft: true,
 * });
 *
 * // Later deploy: publish by setting draft: false
 * const release = yield* GitHub.Release("v1", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   tagName: "v1.0.0",
 *   name: "Version 1.0.0",
 *   body: "Release notes here",
 *   draft: false,
 * });
 * ```
 *
 * ### Auto-Generated Release Notes
 * **Example:** Generate Notes from Commits
 * ```typescript
 * yield* GitHub.Release("v1", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   tagName: "v1.1.0",
 *   name: "Version 1.1.0",
 *   generateReleaseNotes: true,
 * });
 * ```
 *
 * ### Targeting Specific Commits
 * **Example:** Release from Branch or Commit
 * ```typescript
 * yield* GitHub.Release("hotfix", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   tagName: "v1.0.1",
 *   name: "Hotfix 1.0.1",
 *   body: "Critical bug fix",
 *   targetCommitish: "hotfix-branch",
 * });
 * ```
 *
 * ### Updating Releases
 * Deploy with the same logical ID and tag to update the existing release.
 *
 * **Example:** Update Release Notes
 * ```typescript
 * yield* GitHub.Release("v1", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   tagName: "v1.0.0",
 *   name: "Version 1.0.0",
 *   body: `
 *     # What's New
 *
 *     - Feature A
 *     - Feature B
 *     - Bug fixes
 *   `,
 * });
 * ```
 *
 * ### Replacing on Tag Change
 * Changing the tag creates a new release and deletes the old one.
 *
 * **Example:** New Tag = New Release
 * ```typescript
 * // First deploy creates v1.0.0
 * const release = yield* GitHub.Release("latest", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   tagName: "v1.0.0",
 * });
 *
 * // Later deploy with different tag replaces it
 * const release = yield* GitHub.Release("latest", {
 *   owner: "my-org",
 *   repository: "my-repo",
 *   tagName: "v1.1.0",
 * });
 * ```
 *
 * ### Wiring with Other Resources
 * **Example:** Create Repository with Release
 * ```typescript
 * import * as Output from "alchemy/Output";
 *
 * const repo = yield* GitHub.Repository("sdk", {
 *   owner: "my-org",
 *   name: "sdk",
 *   autoInit: true,
 * });
 *
 * yield* GitHub.Release("v1", {
 *   owner: "my-org",
 *   repository: Output.map(repo.fullName, (fullName) => fullName.split("/")[1]!),
 *   tagName: "v1.0.0",
 *   name: "Initial Release",
 *   body: "First public version of the SDK",
 * });
 * ```
 *
 * @resource
 * @product Release
 */
export const Release = Resource<Release>("GitHub.Release");

export const ReleaseProvider = () =>
  Provider.succeed(Release, {
    stables: ["releaseId", "nodeId"],

    // A release belongs to (host, owner, repository, tagName) — changing any
    // of these replaces the resource.
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return;
      if (olds === undefined) return;
      if (
        news.owner !== olds.owner ||
        news.repository !== olds.repository ||
        news.tagName !== olds.tagName ||
        (yield* gitHubBaseUrlChanged(olds, news))
      ) {
        return { action: "replace" };
      }
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const observed = yield* findRelease(olds, output?.releaseId);
      return observed === undefined ? undefined : attrsOf(observed);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const octokit = yield* octokitFor(news.baseUrl);
      const body = news.body !== undefined ? dedent(news.body) : undefined;
      let observed = yield* findRelease(news, output?.releaseId);

      if (observed === undefined) {
        observed = yield* Effect.tryPromise({
          try: () =>
            octokit.rest.repos.createRelease({
              owner: news.owner,
              repo: news.repository,
              tag_name: news.tagName,
              name: news.name,
              body,
              draft: news.draft,
              prerelease: news.prerelease,
              target_commitish: news.targetCommitish,
              generate_release_notes: news.generateReleaseNotes,
            }),
          catch: (error) => error as Error & { status?: number },
        }).pipe(
          Effect.map(({ data }) => data),
          Effect.catchIf(
            (error) => error.status === 422,
            (error) =>
              findRelease(news).pipe(
                Effect.flatMap((release) =>
                  release === undefined
                    ? Effect.fail(error)
                    : Effect.succeed(release),
                ),
              ),
          ),
        );
      }

      const desired = {
        name: news.name ?? news.tagName,
        body: body ?? (news.generateReleaseNotes ? (observed.body ?? "") : ""),
        draft: news.draft ?? false,
        prerelease: news.prerelease ?? false,
      };
      if (
        (observed.name ?? observed.tag_name) === desired.name &&
        (observed.body ?? "") === desired.body &&
        observed.draft === desired.draft &&
        observed.prerelease === desired.prerelease
      ) {
        return attrsOf(observed);
      }

      const { data } = yield* Effect.tryPromise({
        try: () =>
          octokit.rest.repos.updateRelease({
            owner: news.owner,
            repo: news.repository,
            release_id: observed.id,
            tag_name: news.tagName,
            ...desired,
          }),
        catch: (e) => e as Error,
      });

      return attrsOf(data);
    }),

    // Enumerate every release across the repositories the token can see —
    // releases are keyed by {owner, repository, tagName} with no account-wide
    // list endpoint, so walk the repos like the Variable provider does.
    list: Effect.fn(function* () {
      const octokit = yield* Octokit;

      const repos = yield* Effect.tryPromise({
        try: () =>
          octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
            per_page: 100,
          }),
        catch: (e) => e as Error,
      });

      const perRepo = yield* Effect.forEach(
        repos,
        (repo) =>
          Effect.tryPromise({
            try: async () => {
              try {
                const releases = await octokit.paginate(
                  octokit.rest.repos.listReleases,
                  {
                    owner: repo.owner.login,
                    repo: repo.name,
                    per_page: 100,
                  },
                );
                return releases.map(attrsOf);
              } catch (error: any) {
                // Repos where the token lacks release access reject with
                // 403/404 — skip them rather than failing the whole enumeration.
                if (error.status === 403 || error.status === 404) {
                  return [];
                }
                throw error;
              }
            },
            catch: (e) => e as Error,
          }),
        { concurrency: 10 },
      );

      return perRepo.flat();
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const octokit = yield* octokitFor(olds.baseUrl);

      yield* Effect.tryPromise({
        try: async () => {
          try {
            await octokit.rest.repos.deleteRelease({
              owner: olds.owner,
              repo: olds.repository,
              release_id: output.releaseId,
            });
          } catch (error: any) {
            if (error.status !== 404) {
              throw error;
            }
          }
        },
        catch: (e) => e as Error,
      });
    }),
  });

const findRelease = Effect.fn(function* (
  props: ReleaseProps,
  releaseId?: number,
) {
  const octokit = yield* octokitFor(props.baseUrl);
  const request = { owner: props.owner, repo: props.repository };
  if (releaseId !== undefined) {
    const existing = yield* Effect.tryPromise({
      try: () =>
        octokit.rest.repos.getRelease({ ...request, release_id: releaseId }),
      catch: (error) => error as Error & { status?: number },
    }).pipe(
      Effect.map(({ data }) => data),
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.succeed(undefined),
      ),
    );
    if (existing !== undefined && existing.tag_name === props.tagName)
      return existing;
  }
  const published = yield* Effect.tryPromise({
    try: () =>
      octokit.rest.repos.getReleaseByTag({ ...request, tag: props.tagName }),
    catch: (error) => error as Error & { status?: number },
  }).pipe(
    Effect.map(({ data }) => data),
    Effect.catchIf(
      (error) => error.status === 404,
      () => Effect.succeed(undefined),
    ),
  );
  if (published !== undefined) return published;

  // The tag endpoint excludes drafts, including drafts recovered without state.
  const releases = yield* Effect.tryPromise({
    try: () =>
      octokit.paginate(octokit.rest.repos.listReleases, {
        ...request,
        per_page: 100,
      }),
    catch: (error) => error as Error & { status?: number },
  }).pipe(
    Effect.catchIf(
      (error) => error.status === 404,
      () => Effect.succeed([]),
    ),
  );
  return releases.find((release) => release.tag_name === props.tagName);
});

const attrsOf = (data: {
  id: number;
  node_id: string;
  tag_name: string;
  name: string | null;
  body?: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  upload_url: string;
  created_at: string;
  published_at: string | null;
}) => ({
  releaseId: data.id,
  nodeId: data.node_id,
  tagName: data.tag_name,
  name: data.name ?? data.tag_name,
  body: data.body ?? "",
  draft: data.draft,
  prerelease: data.prerelease,
  htmlUrl: data.html_url,
  uploadUrl: data.upload_url,
  createdAt: data.created_at,
  publishedAt: data.published_at,
});
