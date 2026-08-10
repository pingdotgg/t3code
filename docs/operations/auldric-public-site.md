# Auldric public-site operations

This runbook builds and deploys the separate `@auldric/public` static site. It does not deploy
T3's `@t3tools/marketing` application and must not take over a T3 host, callback, release, or legal
route.

## Default verification

From the repository root, run package-scoped checks:

```bash
pnpm --filter @auldric/public test
pnpm --filter @auldric/public typecheck
pnpm --filter @auldric/public build
```

The build verifies the release record before Astro emits `apps/auldric-public/dist`, then inspects
every generated route, internal link, metadata boundary, default waitlist, default download, and
crawler state. With the checked-in empty release record, the build performs no network request.

## Publication inputs

Set these at build time before publishing an indexable site:

| Variable                                 | Required value                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `PUBLIC_AULDRIC_SITE_URL`                | Exact root HTTPS URL on `auldric.com` or an Auldric subdomain          |
| `PUBLIC_AULDRIC_LEGAL_NAME`              | Reviewed legal site operator                                           |
| `PUBLIC_AULDRIC_PRIVACY_CONTACT`         | Monitored privacy email                                                |
| `PUBLIC_AULDRIC_LEGAL_ADDRESS`           | Reviewed postal address for the legal operator                         |
| `PUBLIC_AULDRIC_LEGAL_JURISDICTION`      | Reviewed governing jurisdiction                                        |
| `PUBLIC_AULDRIC_WAITLIST_RETENTION_DAYS` | Integer from 1 through 730; also required before the waitlist can open |

Without the site URL and all four legal identity values, the generated pages carry
`noindex,nofollow` and `robots.txt` disallows the site. The checked-in defaults are safe for review,
not public launch.

## Optional access

After the publication inputs are complete, product access opens only with both values:

```text
PUBLIC_AULDRIC_ACCESS_STATUS=available
PUBLIC_AULDRIC_ACCESS_URL=https://app.auldric.com/
```

The destination must use HTTPS, an Auldric host, and an origin different from the public site. The
destination owns its own sign-in, verified actor, authorization, legal terms, failure handling, and
recovery. Do not point it at a T3 hosted app or at the public site itself.

## Optional waitlist

Waitlist collection opens only when the publication inputs and these values are complete:

```text
PUBLIC_AULDRIC_WAITLIST_STATUS=open
PUBLIC_AULDRIC_WAITLIST_ENDPOINT=https://<real-endpoint>/...
```

Before enabling it, verify that the endpoint:

- accepts cross-origin `POST` requests with `email`, `consent`, and `consentVersion` form fields;
- uses a credential-free HTTPS URL with no query string or fragment;
- returns a direct successful HTTP response and does not rely on a redirect;
- records the consent purpose and enforces the published retention period;
- supports access, correction, withdrawal, and deletion through the published privacy contact;
- never imports donor waitlist rows or treats a submission as product access.

The public form sends no cookies or credentials. A failed request stays failed and shows a retry
message; the page never presents a synthetic success state.

## Optional verified download

Downloads require complete publication inputs and are controlled by the checked-in
`apps/auldric-public/src/content/verified-releases.json` record. To propose an artifact:

1. Publish the Auldric-owned artifact under the exact
   `https://github.com/AuldricAI/auldrics/releases/download/` path.
2. Obtain its filename, platform, semantic version, and SHA-256 from the release process.
3. Add a unique record and review its provenance, signer, and platform support.
4. Run the package build with network access. The build fetches the file and recomputes its digest.
5. Only after that succeeds, set:

   ```text
   PUBLIC_AULDRIC_DOWNLOAD_STATUS=available
   PUBLIC_AULDRIC_DOWNLOAD_ARTIFACT_ID=<reviewed-record-id>
   ```

An environment variable cannot add a URL, filename, version, platform, or checksum. A missing,
unselected, unreachable, redirected-to-error, or hash-mismatched record fails closed. Never use a
T3 installer, donor binary, unreviewed repository tag, or a generic “latest release” lookup.

## Deploy and roll back

Publish only `apps/auldric-public/dist` to the Auldric public origin. Preserve `404.html`,
`robots.txt`, `sitemap.xml`, the `_astro` asset directory, and the root SVG assets. Configure the
host to use `404.html` for unknown paths; do not rewrite unknown paths to a product or T3 route.

Rollback is the prior static output plus its prior build-time inputs. It must not modify
`apps/marketing`, `t3.codes`, `app.t3.codes`, T3 callbacks, T3 releases, or any product database.
