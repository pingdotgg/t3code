# @alchemy.run/pkg

Preview packages for pull requests. A Cloudflare Worker registry that verifies every publication against the GitHub Actions run that produced it, plus the `pkg` CLI that packs workspace packages and publishes them from CI.

Install URLs look like `https://pkg.alchemy.run/<name>/<tag>`, where `<tag>` is a commit SHA, a short SHA, `branch:<name>`, or `pr:<number>`:

```sh
pnpm install https://pkg.alchemy.run/alchemy/pr:1516
pnpm install https://pkg.alchemy.run/alchemy/branch:main
pnpm install https://pkg.alchemy.run/alchemy/163c051
```

## How a publication flows

Every publication is a GitHub Actions **run**. The registry never trusts what a client says about commits, branches, or pull requests; it resolves the run through the GitHub API and derives every tag from that.

1. One workflow runs on `push` and `pull_request`, builds the workspace, runs `pkg pack`, uploads the manifest as an artifact with `actions/upload-artifact`, and runs `pkg publish`. It needs no permissions and no secrets, so fork pull requests run it exactly like everything else.
2. `pkg pack` prints the artifact name, `pkg-manifest-<sha256 of the manifest>`, as the `artifact-name` step output for the upload. Only the job's runtime token can add artifacts to the run, and the runner exposes that token to actions alone, which is why the upload is its own step. The artifact is GitHub's record that this run vouched for exactly these package hashes.
3. Requests name the run they come from (repository, run id, attempt) and nothing else. The registry fetches the run through the App, requires it to be in progress, lists its artifacts, and refuses any manifest whose hash is not vouched for. Someone naming another run can only ever get that run's own manifest accepted, which changes nothing.
4. One idempotent publish either answers with the tarballs it lacks, which the CLI uploads before publishing again, or points the tags, posts a "Preview packages" check run on the commit, and for pull requests updates the sticky comment. The manifest's `head` has to be the run's head commit, so a `pull_request` job must check out `github.event.pull_request.head.sha` rather than the merge commit.
5. A run from a fork gets only the `pr:<number>` tag. Commit and branch tags are shared by every publisher, and a fork can run any commit, including one the repository already published, so it may not write them.

## The `pkg` CLI

```sh
pkg pack \
  --group 'alchemy=./packages/alchemy' \
  --group '@alchemy.run[Collapsed]=./packages/{better-auth,pkg}' \
  --group '@distilled.cloud[Collapsed]=./submodules/distilled/packages/*' \
  --registry https://pkg.alchemy.run \
  --out .pkg

pkg publish --dir .pkg --registry https://pkg.alchemy.run
```

| Flag         | Command         | Default                                     |
| ------------ | --------------- | ------------------------------------------- |
| `--group`    | `pack`          | required, repeatable                        |
| `--registry` | `pack`, `publish` | `PKG_REGISTRY` env var, then `https://pkg.alchemy.run` |
| `--out`      | `pack`          | `.pkg`                                      |
| `--dir`      | `publish`       | `.pkg`                                      |

A group is `NAME=GLOB` or `NAME[Collapsed]=GLOB`. Globs support `*` as a whole path segment and `{a,b}` alternatives, so `./submodules/distilled/packages/{core,aws}` lists exactly those two. Repeat `--group` with the same name to add more directories to one group. `Collapsed` renders that group inside a closed `<details>` block in the install comment, for long lists of secondary packages.

For each non-private package under a group's glob, `pack`:

- packs in dependency order and rewrites every dependency on another packed package to that package's immutable tarball URL, `https://<registry>/<name>/-/<sha256>.tgz`, so a tarball's bytes depend only on its source and its dependencies' bytes and identical builds deduplicate across commits, pull requests, and repositories;
- repacks with fixed timestamps and no ownership so identical inputs hash identically, letting the registry skip uploads it already has;
- writes `pkg-manifest.json` describing the groups and each tarball's name, group, SHA-256, and size.

`publish` must run inside a GitHub Actions job, after the workflow has uploaded the manifest artifact. It refuses a directory packed for a different registry. `pack` alone is useful to inspect what would be published.

Under a `pull_request` event, check out `github.event.pull_request.head.sha` before packing. The default checkout is a synthetic merge commit that does not match the run's head, and `pack` fails early when it detects that.

## Deploying the registry

The registry is one call in a Stack. It declares the Worker, the R2 bucket, the D1 index, and a KV cache under the id you give it, as `Pkg/Worker`, `Pkg/Bucket`, `Pkg/Database`, and `Pkg/Cache`:

```ts
import { PkgRegistry } from "@alchemy.run/pkg/Registry";

const registry = yield* PkgRegistry("Pkg", {
  worker: { domain: "pkg.alchemy.run" },
  github: {
    appId: Config.String("GH_APP_ID"),
    privateKey: Config.Redacted("GH_APP_PRIVATE_KEY"),
  },
  policy: {
    repos: ["alchemy-run/alchemy", "alchemy-run/distilled"],
    ttl: Duration.weeks(1),
    maxPackageSize: ByteSize.megabytes(100),
  },
  aliases: { "pkg.distilled.cloud": "@distilled.cloud" },
});
```

| Option                  | Default                  | Meaning                                                                                  |
| ----------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `worker`                | `{}`                     | Any Worker prop except `main`, `env`, and `crons`, which the registry owns               |
| `github.appId`          | required                 | The App id, read at deploy time and bound to the Worker                                  |
| `github.privateKey`     | required                 | The App's private key PEM, bound as a secret                                             |
| `github.apiUrl`         | `https://api.github.com` | GitHub API origin                                                                        |
| `policy.repos`          | required                 | Repositories allowed to publish, as `owner/name`                                         |
| `policy.ttl`            | one week                 | How long a publication lives                                                             |
| `policy.maxPackageSize` | unlimited                | Upper bound on a single tarball                                                          |
| `aliases`               | `{}`                     | Hostname to package scope, so `pkg.distilled.cloud/core/<sha>` serves `@distilled.cloud/core` |
| `cron`                  | `0 * * * *`              | Schedule of the expiry sweep                                                             |

The package ships the Worker's bundle entry, so no separate entry file is needed. The options are encoded into a `PKG_SETTINGS` json binding at deploy time and decoded back inside the isolate, and the App credentials are bound as `PKG_GITHUB_APP_ID` and `PKG_GITHUB_APP_PRIVATE_KEY` and read lazily on the first GitHub call. The App needs `checks: write`, `pull_requests: write`, and `actions: read` on every repository in `policy.repos`.

The KV namespace caches what the Worker learns from GitHub, shared by every isolate: resolved runs for a minute, so the uploads that follow a publish do not repeat the lookup, and installation tokens until shortly before they expire, so one mint per repository serves about an hour. Everything in it is re-derivable, and a KV failure falls through to GitHub.

`alchemy dev` runs the Worker locally with the bucket, database, and cache emulated; the GitHub calls still go to the real API.

## HTTP API

The contract lives in `@alchemy.run/pkg/Protocol` as an Effect `HttpApi`. The Worker implements it with `HttpApiBuilder`; the CLI calls it through `HttpApiClient`, so requests and typed errors are shared rather than duplicated.

| Route                                     | Purpose                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /api/publish`                       | Body `{ run, manifest }`. Answers `409 MissingTarballs` with what to upload, or the tags |
| `PUT /api/tarballs/:name/:sha256?repo&runId&attempt` | Content-addressed upload, streamed into R2 with the hash verified by R2      |
| `GET /api/health`                         | `{ ok: true }`                                                                           |
| `GET /<name>/<tag>`                       | 302 to the tarball the tag points at                                                     |
| `GET /<name>/-/<sha256>.tgz`              | The immutable tarball                                                                    |

`run` is `{ repo, runId, attempt }`. Errors are `BadRequest` (400), `Forbidden` (403), `RunNotInProgress` (409), `MissingTarballs` (409), `PackageTooLarge` (413), and `Upstream` (502) for GitHub failures.

## Policy

`repos` lists the repositories allowed to publish. A publication may contain any package; every package gets the commit, short commit, `branch:<name>`, and `pr:<number>` tags of the run that produced it, and nothing in the manifest can name a different commit. A package built from a submodule is therefore tagged with the publishing repository's commit; dependency links between tarballs use content URLs and do not involve commits at all.

## Cleanup

The registry keeps one table: `tags(package, tag, sha256, expires_at, linked_prs)`. A tarball lives in R2 for as long as any row points at it.

Every publication of a tag refreshes `expires_at` to now plus `ttl`. Rows produced by pull request runs also record the pull request in `linked_prs`; a commit tag shared by several pull requests records all of them. The sweep re-checks rows that are about to expire: while any linked pull request is open the row is extended by `ttl`, and once they are all closed or merged the expiry is pinned to the latest close time plus `ttl`. Branch publications simply expire `ttl` after the push. The sweep then deletes expired rows, tarballs no row points at, and uploads older than a day that never got tagged.
