// Pure SPA: no server-side rendering for any page. Endpoints (+server.ts)
// still run server-side in the worker — that split is what this fixture
// exercises.
export const ssr = false;
// Do not prerender the pages either; the adapter's
// `notFoundHandling: "single-page-application"` generates the app-shell
// `index.html` fallback instead.
export const prerender = false;
