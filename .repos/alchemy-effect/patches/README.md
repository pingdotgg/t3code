# Website incremental-build patches

Astro's experimental incremental static builds require a `cacheKey` for each
`getStaticPaths()` result. Keep these patches when updating the dependencies:

- `@astrojs/starlight`: use the content digest for docs, and include all blog
  digests for blog pages because their recent-post sidebar depends on other posts.
  Starlight 0.42 ships compiled code under `dist/` and no longer passes a route
  through `props`; the patch deliberately only adds `cacheKey`.
- `starlight-blog`: invalidate listing, tag, and author pages when their locale's
  blog entries change. Otherwise Astro cannot cache these generated pages.

After rebasing a patch, install with the workspace package manager and verify a
forced build followed by an unchanged build. The second build should report
cached Starlight HTML and OG routes. Never increase Astro's `build.concurrency`
above 1: that disables incremental caching. Full and docs-only CI jobs use
separate cache namespaces because docs-only builds prune the omitted OG routes.

OG routes hash the rendered React markup (including inline styles and the yantra
SVG), font metadata and bytes, and render options. Their keys do not depend on a
fixed slug or a document body digest. Astro additionally tracks the route's
bundled dependencies and invalidates its cache when the lockfile changes.


# miniflare 4

The pnpm override runs miniflare 4 (used by the e2e harness in
`@alchemy.run/cloudflare-test-tools`) on the workspace's workerd. Since
`1.20261026.1`, workerd's disk service rejects backslashes in request paths,
and miniflare 4 builds its asset manifest from Windows paths, so assets below
the root fail on Windows. The patch writes the paths with `/`, as miniflare 5
does (cloudflare/workers-sdk#16307). Drop it when the harness moves to
miniflare 5.
