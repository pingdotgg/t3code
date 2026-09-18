/**
 * The `github` group: a GitHub REST v3 facade at `/api/v3`, so `gh api`
 * and Octokit work against the host unmodified (DESIGN.md §5). The routes
 * answer with GitHub-shaped JSON they build themselves and declare no
 * success schema.
 */
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

/** `GET /user`: the credential probe `gh` makes; answer it from your own user record. */
export const GitHubUser = HttpApiEndpoint.get("user", "/user", {});

/** `GET /repos/:owner/:repo` */
export const GitHubRepo = HttpApiEndpoint.get(
  "repo",
  "/repos/:owner/:repo",
  {},
);

/** `GET /repos/:owner/:repo/branches` */
export const GitHubBranches = HttpApiEndpoint.get(
  "branches",
  "/repos/:owner/:repo/branches",
  {},
);

/** `GET /repos/:owner/:repo/commits` */
export const GitHubCommits = HttpApiEndpoint.get(
  "commits",
  "/repos/:owner/:repo/commits",
  {},
);

/** `GET /repos/:owner/:repo/commits/:sha` */
export const GitHubCommit = HttpApiEndpoint.get(
  "commit",
  "/repos/:owner/:repo/commits/:sha",
  {},
);

/** `GET /repos/:owner/:repo/contents/*` */
export const GitHubContents = HttpApiEndpoint.get(
  "contents",
  "/repos/:owner/:repo/contents/*",
  {},
);

/** `GET /repos/:owner/:repo/pulls` */
export const GitHubPulls = HttpApiEndpoint.get(
  "pulls",
  "/repos/:owner/:repo/pulls",
  {},
);

/** `POST /repos/:owner/:repo/pulls` */
export const GitHubCreatePull = HttpApiEndpoint.post(
  "createPull",
  "/repos/:owner/:repo/pulls",
  {},
);

/** `GET /repos/:owner/:repo/pulls/:number` */
export const GitHubPull = HttpApiEndpoint.get(
  "pull",
  "/repos/:owner/:repo/pulls/:number",
  {},
);

/** `PATCH /repos/:owner/:repo/pulls/:number` */
export const GitHubUpdatePull = HttpApiEndpoint.patch(
  "updatePull",
  "/repos/:owner/:repo/pulls/:number",
  {},
);

/** `PUT /repos/:owner/:repo/pulls/:number/merge` */
export const GitHubMergePull = HttpApiEndpoint.put(
  "mergePull",
  "/repos/:owner/:repo/pulls/:number/merge",
  {},
);

/** `GET /repos/:owner/:repo/pulls/:number/files` */
export const GitHubPullFiles = HttpApiEndpoint.get(
  "pullFiles",
  "/repos/:owner/:repo/pulls/:number/files",
  {},
);

/** The GitHub facade, mounted at `/api/v3`. */
export class GitHub extends HttpApiGroup.make("github")
  .add(
    GitHubUser,
    GitHubRepo,
    GitHubBranches,
    GitHubCommits,
    GitHubCommit,
    GitHubContents,
    GitHubPulls,
    GitHubCreatePull,
    GitHubPull,
    GitHubUpdatePull,
    GitHubMergePull,
    GitHubPullFiles,
  )
  .prefix("/api/v3") {}
