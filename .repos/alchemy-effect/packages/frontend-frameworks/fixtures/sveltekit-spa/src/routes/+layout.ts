// Pure SPA: no server-side rendering for any page. Endpoints (+server.ts)
// still run server-side — that nuance is what this fixture exercises.
export const ssr = false;
// Do not prerender the pages either; the adapter's
// `notFoundHandling: "single-page-application"` generates the index.html
// app-shell fallback via `builder.generateFallback` instead.
export const prerender = false;
