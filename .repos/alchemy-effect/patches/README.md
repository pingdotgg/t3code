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
