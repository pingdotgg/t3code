# gcp-static-site

A static website served from a public Cloud Storage bucket. The GCP
counterpart of [`aws-static-site`](../aws-static-site).

```
site/ ──GCP.Storage.Files──> gs://…/index.html, styles.css, docs/index.html, 404.html
                                   │ allUsers: roles/storage.objectViewer
                                   v
          https://storage.googleapis.com/<bucket>/index.html
```

- `GCP.Storage.Bucket("Site")` — uniform bucket-level access, website
  config `mainPageSuffix: "index.html"` and `notFoundPage: "404.html"`,
  and `forceDestroy: true` so destroy empties it.
- `GCP.IAM.Member("PublicRead")` — grants `allUsers`
  `roles/storage.objectViewer` on the bucket's own IAM policy. Anyone can
  read (and list) the objects; nothing else in the project is exposed.
- `GCP.Storage.Files("SiteFiles")` — one `GCP.Storage.Object` per file
  under `site/`, keyed by its relative path, with `Content-Type` inferred
  from the extension (`text/html; charset=utf-8`, `text/css; charset=utf-8`,
  `image/png`, …). HTML is served `Cache-Control: no-cache`; everything
  else `public, max-age=300`.

There are no Functions, bindings, or event sources — nothing runs
server-side.

## How redeploys work

Each `Object` compares the MD5 Cloud Storage reports with the MD5 of the
local file (plus its `Content-Type` and `Cache-Control`). A redeploy
uploads only files whose bytes or headers changed, and deletes the objects
of files you removed from `site/`.

## Links on path-style URLs

On `https://storage.googleapis.com/<bucket>/…` the bucket name is part of
the path, so the pages link to each other with relative URLs
(`styles.css`, `docs/index.html`). Root-relative links (`/styles.css`)
only work once the site is served from its own domain.

## Custom domain and HTTPS

The website config (`mainPageSuffix`, `notFoundPage`) only takes effect
when the bucket is served from a domain: a `/docs/` → `docs/index.html`
rewrite and the `404.html` body are not applied to path-style URLs, which
answer a missing object with Cloud Storage's own 404. Serving the site on
a custom domain over HTTPS requires a global external Application Load
Balancer with a backend bucket, a managed certificate, and a DNS record —
out of scope for this example.

## Deploy

Credentials come from your alchemy profile: run `alchemy profile` once and pick GCP (*Service account JSON* for a key file, or *Stored* for an access token or key kept in `~/.alchemy/credentials`, plus a default region), then deploy with `--profile <name>`. No Docker needed.

```sh
pnpm deploy --profile <name>
```

```sh
curl -i "$url"                                               # index.html
curl -i "https://storage.googleapis.com/$bucketName/styles.css"
```

The project must allow public buckets: the
`constraints/storage.publicAccessPrevention` and
`constraints/iam.allowedPolicyMemberDomains` organization policies both
block `allUsers` grants.

## Test

```sh
ALCHEMY_PROFILE=<name> bun test
```

Deploys the stack, fetches `index.html`, `styles.css`, `docs/index.html`
and `404.html` anonymously and checks each body, `Content-Type` and
`Cache-Control`, checks a missing path is a 404, reads the bucket's
website config and IAM policy back from the Cloud Storage API, then
destroys the stack and checks the bucket is gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
