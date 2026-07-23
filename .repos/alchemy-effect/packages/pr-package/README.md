# @alchemy.run/pr-package

A self-hostable PR-package service for Cloudflare. Publish ephemeral, tag-addressable npm tarballs (e.g. one per PR commit) and install them with a pretty URL like `https://pkg.ing/<pkg>/<sha>`.

It packages four Cloudflare resources into a single Effect `handler`:

- **R2** bucket — stores `.tgz` blobs
- **KV** namespace — tag → resourceId index
- **Secrets Store** + a `Random`-generated **bearer token** — gates writes
- **Durable Object** — per-resource download stats and TTL state

## Install

```sh
bun add @alchemy.run/pr-package
```

## Usage

The package exposes a `handler(options)` Effect that you wire into a `Cloudflare.Worker` you own. The reason it can't own the worker for you: Cloudflare bundles the worker starting from a single entry file, and `parseAliasUrl` is a JS closure — it has to live in (or be reachable from) your stack file's module graph. So the worker class lives in your project, and the package contributes the routing.

### Minimum viable

Two-file pattern, mirroring how `stacks/otel/Ingester.ts` is split out from `stacks/otel.ts`:

```ts
// stacks/pr-package/Api.ts — the worker entry (main: import.meta.path)
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
    main: import.meta.path,
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
import * as Effect from "effect/Effect";
import Api from "./pr-package/Api.ts";

export default Alchemy.Stack(
  "PrPackage",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const authToken = yield* PrPackage.AuthTokenValue;
    const api = yield* Api;
    return {
      url: api.url.as<string>(),
      authToken: authToken.text, // Redacted bearer token for uploads
    };
  }),
);
```

Deploy:

```sh
bun alchemy deploy ./stacks/pr-package.ts --stage prod
```

The stack output gives you the worker URL and the auto-generated bearer token. Save the token — you'll need it to publish.

> **Why two files?** Putting the `Worker` class and `Alchemy.Stack(...)` in the same file pulls the alchemy CLI/state-store surface into the worker bundle and breaks at runtime (`No such module "sisteransi"` and similar). Splitting the worker class into its own file keeps the worker bundle minimal.

### `handler(options)` options

| Option          | Type                                | Default          | Notes                                                                |
| --------------- | ----------------------------------- | ---------------- | -------------------------------------------------------------------- |
| `parseAliasUrl` | `(url: URL) => AliasMatch \| null`  | `() => null`     | Maps any non-`/projects/...` GET to `{ pkgName, tag }` for a 301.    |
| `defaultTtl`    | `string` (Effect Duration)          | `"3 weeks"`      | TTL applied when an upload doesn't pass `X-TTL`.                     |

`AliasMatch` is `{ pkgName: string; tag: string }`. Returning `null` falls through to the regular `/projects/:pkgName/...` matcher.

## API

All routes are scoped by `:pkgName`, which can be scoped (`@scope/name`) or unscoped (`name`) — matches npm package naming.

### `PUT /projects/:pkgName/packages` — upload

Headers:
- `Authorization: Bearer <token>` (required)
- `Content-Type: application/gzip`
- `X-Tags: <json-array>` (required) — e.g. `["main","abc1234","abc1234abc1234..."]`
- `X-TTL: <duration>` (optional) — e.g. `"7 hours"`, `"3 weeks"`. Effect `Duration` syntax.
- `Content-Length` (required)

Body: raw `.tgz` stream. Streamed straight to R2.

Returns `{ resourceId, project, tags, ttl, expiresAt }`.

If a tag was already pointing somewhere, the old resource has the tag removed; if it was the resource's last tag, the blob and metadata are deleted.

### `GET /<alias-path>` — pretty install URL → 301

Whenever the path doesn't start with `/projects/`, the request URL is handed to `parseAliasUrl(url)`. If it returns a match, the worker 301s to `/projects/:pkgName/tags/:tag`. Otherwise 404.

### `GET /projects/:pkgName/tags/:tag` — resolve tag → 302 to blob

Looks up `tag → resourceId`, records a download in the per-resource Durable Object, and 302s to `/projects/:pkgName/packages/:resourceId`.

### `GET /projects/:pkgName/packages/:resourceId` — serve blob

Returns the `.tgz` with `cache-control: public, max-age=31536000, immutable`. No auth required (resourceIds are unguessable UUIDs).

### `DELETE /projects/:pkgName/tags/:tag` — remove tag

Auth required. If the tag was the resource's last one, the blob and metadata are also deleted.

### `GET /projects/:pkgName/packages/:resourceId/stats` — download stats

Auth required. Returns `{ downloads: { [tag]: number }, totalDownloads: number }`.

## Publishing from CI

```sh
bun pm pack --destination .
tgz=$(ls *.tgz)
curl -fsSL --show-error -X PUT \
  "https://pkg.example.com/projects/my-pkg/packages" \
  -H "Authorization: Bearer ${PR_PACKAGE_TOKEN}" \
  -H "X-Tags: $(jq -nc --arg sha "$GITHUB_SHA" --arg short "${GITHUB_SHA:0:7}" '[$short, $sha, "main"]')" \
  -H "Content-Type: application/gzip" \
  --data-binary "@${tgz}"
```

Then consumers install with:

```sh
bun add https://pkg.example.com/projects/my-pkg/tags/abc1234
# or via parseAliasUrl, e.g.:
bun add https://pkg.example.com/my-pkg/abc1234
```

See `.github/workflows/pr-package.yaml` in this repo for the full pipeline (publish on push/PR sync, sticky comment with install URLs, tag cleanup on PR close).

## Cleaning up state

If a deploy errors mid-flight and leaves orphan state:

```sh
bun alchemy state resources <StackName> <stage> ./your/stack.ts --profile <p>
bun alchemy state clear     <StackName> <stage> ./your/stack.ts --profile <p> --yes
```

Then reconcile any actually-created Cloudflare resources via the dashboard before redeploying.
