# @alchemy.run/pr-package

A self-hostable PR-package service for Cloudflare. Publish content-addressed npm tarballs, point ephemeral tags at them, and install with a pretty URL like `https://pkg.ing/<pkg>/<sha>`.

It packages four Cloudflare resources into a single Effect `handler`:

- **R2** bucket — stores `.tgz` blobs by `(package, sha256)`
- **KV** namespace — tag → content-addressed tarball pointer
- **Secrets Store** + a `Random`-generated **bearer token** — gates writes
- **Durable Object** — per-tarball download stats and scheduled TTL cleanup

## Install

```sh
bun add @alchemy.run/pr-package
```

## Usage

The package exposes a `handler(options)` Effect that you wire into a `Cloudflare.Worker` you own. The reason it can't own the worker for you: Cloudflare bundles the worker starting from a single entry file, and `parseAliasUrl` is a JS closure — it has to live in (or be reachable from) your stack file's module graph. So the worker class lives in your project, and the package contributes the routing.

### Minimum viable

Two-file pattern, mirroring how `stacks/otel/Ingester.ts` is split out from `stacks/otel.ts`:

```ts
// stacks/pr-package/Api.ts — the worker entry (main: import.meta.url)
import * as PrPackage from "@alchemy.run/pr-package";
import * as Cloudflare from "alchemy/Cloudflare";

const parseAliasUrl: PrPackage.ParseAliasUrl = (url) => {
  // Map any alias host's URL to { pkgName, tag }, or return null to fall through.
  // E.g. https://pkg.example.com/<pkg>/<tag>:
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length === 2) {
    return { pkgName: segments[0]!, tag: segments[1]! };
  }
  return null;
};

export default class Api extends Cloudflare.Worker<Api>()(
  "PrPackageWorker",
  {
    main: import.meta.url,
    url: true,
    domain: ["pkg.example.com"],
    compatibility: { flags: ["nodejs_compat"], date: "2026-03-17" },
  },
  PrPackage.handler({ parseAliasUrl }),
) {}
```

```ts
// stacks/pr-package.ts — the stack
import * as PrPackage from "@alchemy.run/pr-package";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import Api from "./pr-package/Api.ts";

export default Alchemy.Stack(
  "PrPackage",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const authToken = yield* PrPackage.AuthTokenValue;
    const api = yield* Api;
    return {
      url: api.url.as<string>(),
      // Unwrap the Redacted so the stack output emits the real token —
      // otherwise it serializes to the literal string "<redacted>".
      authToken: authToken.text.pipe(Output.map(Redacted.value)),
    };
  }),
);
```

Deploy:

```sh
bun alchemy deploy --config ./stacks/pr-package.ts --stage prod
```

The stack output gives you the worker URL and the auto-generated bearer token. Save the token — you'll need it to publish.

> **Why two files?** Putting the `Worker` class and `Alchemy.Stack(...)` in the same file pulls the alchemy CLI/state-store surface into the worker bundle and breaks at runtime (`No such module "sisteransi"` and similar). Splitting the worker class into its own file keeps the worker bundle minimal.

### `handler(options)` options

| Option          | Type                                | Default          | Notes                                                                |
| --------------- | ----------------------------------- | ---------------- | -------------------------------------------------------------------- |
| `parseAliasUrl` | `(url: URL) => AliasMatch \| null`  | `() => null`     | Maps any non-`/projects/...` GET to `{ pkgName, tag }` for a 301.    |
| `defaultTtl`    | `string` (Effect Duration)          | `"3 weeks"`      | TTL applied when a tag request doesn't pass `Alchemy-TTL`.           |

`AliasMatch` is `{ pkgName: string; tag: string }`. Returning `null` falls through to the regular `/projects/:pkgName/...` matcher.

## API

All routes are scoped by `:pkgName`, which can be scoped (`@scope/name`) or unscoped (`name`) — matches npm package naming.

### `HEAD /projects/:pkgName/packages/:sha256` — probe

Checks whether the backing tarball identified by `(package name, SHA-256)` already exists. Authentication is required. Returns 200 when present and 404 otherwise.

### `PUT /projects/:pkgName/packages/:sha256` — upload

Uploads the raw `.tgz` stream when the content-addressed backing tarball is absent. Authentication, `Content-Type: application/gzip`, and a matching `Content-Length` are required. Repeating the request is idempotent and does not overwrite existing content.

### `PUT /projects/:pkgName/tags` — point tags

Assigns tags to an existing backing tarball without uploading its bytes again.

Headers:

- `Authorization: Bearer <token>` (required)
- `Alchemy-Tarball-Hash: <sha256>` (required)
- `Alchemy-Tags: <json-array>` (required) — e.g. `["main","abc1234","abc1234abc1234..."]`
- `Alchemy-TTL: <duration>` (optional) — e.g. `"7 hours"`, `"3 weeks"`. Effect `Duration` syntax.
- `Alchemy-Pull-Request: <owner/repo#number>` (optional) — e.g. `alchemy-run/alchemy#123` or `https://github.com/alchemy-run/alchemy/pull/123`. Ties this tarball to a GitHub pull request.

If a tag already points elsewhere, it moves to the new tarball. A tarball is deleted after its final tag is removed.

Assigning tags schedules a named Durable Object expiration event. When it fires:

- If the tarball is **not** tied to a pull request, every KV tag that still points at it is removed, the R2 blob is deleted, and state is cleared.
- If it **is** tied to one or more pull requests, the service checks each on GitHub. While any tied PR is open the TTL renews. A closed PR releases only the tags that were assigned with that PR and that no other open PR also claims — other tags on the same content-addressed tarball, such as `main` or another PR's commit tag, are left alone. Once no tied PR remains open, the whole tarball expires.
- A PR GitHub cannot confirm (rate limit, outage, private repo) keeps renewing for up to 28 days after it was last seen open, then is treated as closed.

Reassigning the tarball before expiry reschedules the event.

Set `GITHUB_TOKEN` in the deploy environment to bind a token for these lookups; unauthenticated GitHub requests share a 60/hour limit per egress IP, which is not enough for a busy registry.

### `GET /<alias-path>` — pretty install URL → 301

Whenever the path doesn't start with `/projects/`, the request URL is handed to `parseAliasUrl(url)`. If it returns a match, the worker 301s to `/projects/:pkgName/tags/:tag`. Otherwise 404.

### `GET /projects/:pkgName/tags/:tag` — resolve tag → 302 to tarball

Looks up the tag's `(package name, SHA-256)` pointer, records a download, and redirects to the immutable tarball URL.

### `GET /projects/:pkgName/packages/:sha256` — serve tarball

Returns the `.tgz` with `cache-control: public, max-age=31536000, immutable`. No auth required; the URL itself is content-addressed.

### `DELETE /projects/:pkgName/tags/:tag` — remove tag

Auth required. If the tag was the tarball's last one, the backing blob is also deleted.

### `DELETE /projects/:pkgName/pull-requests/:number` — tear down a PR preview

Auth required. Looks up the `pr-<number>` tag and removes every tag that was assigned together with that pull request (commit, branch, and `pr-N` aliases). Tags that were pointed at the same tarball without the PR (for example `main`) or that another open PR also claims are kept. If no tags remain, the backing blob is deleted.

Use this from CI on `pull_request` closed so preview install URLs stop resolving immediately instead of waiting for the next TTL.

### `GET /projects/:pkgName/packages/:sha256/stats` — download stats

Auth required. Returns `{ downloads: { [tag]: number }, totalDownloads: number }`.

## Publishing from CI

```sh
bun pm pack --destination .
tgz=$(ls *.tgz)
hash=$(sha256sum "$tgz" | cut -d ' ' -f 1)
size=$(wc -c < "$tgz" | tr -d ' ')
base="https://pkg.example.com/projects/my-pkg"

curl -fsSI -H "Authorization: Bearer ${PR_PACKAGE_TOKEN}" \
  "$base/packages/$hash" || \
curl -fsS -X PUT -H "Authorization: Bearer ${PR_PACKAGE_TOKEN}" \
  -H "Content-Type: application/gzip" -H "Content-Length: $size" \
  --data-binary "@$tgz" "$base/packages/$hash"

curl -fsS -X PUT -H "Authorization: Bearer ${PR_PACKAGE_TOKEN}" \
  -H "Alchemy-Tarball-Hash: $hash" \
  -H "Alchemy-Tags: [\"${GITHUB_SHA:0:7}\",\"$GITHUB_SHA\",\"main\"]" \
  "$base/tags"
```

Then consumers install with:

```sh
bun add https://pkg.example.com/projects/my-pkg/tags/abc1234
# or via parseAliasUrl, e.g.:
bun add https://pkg.example.com/my-pkg/abc1234
```

See `.github/workflows/pr-package.yml` in this repo for the full pipeline (publish on push/PR sync, sticky comment with install URLs, PR-tied TTL renewal while the PR is open, tag cleanup and a teardown comment on PR close).

## Cleaning up state

If a deploy errors mid-flight and leaves orphan state:

```sh
bun alchemy state list <StackName>/<stage> --config ./your/stack.ts --profile <p>
bun alchemy state delete <StackName>/<stage> --config ./your/stack.ts --profile <p>
```

Then reconcile any actually-created Cloudflare resources via the dashboard before redeploying.
