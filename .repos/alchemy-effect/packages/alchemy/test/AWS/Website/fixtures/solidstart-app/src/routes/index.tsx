declare const __FIXTURE_MARKER__: string;

/**
 * SSR home page. Renders three markers the live and local tests assert on:
 *
 * - `SOLIDSTART_AWS_PAGE_MARKER` — the page was server-rendered at all.
 * - `config:<marker>` — the fixture's own `vite.config.ts` `define` applied.
 * - `env:<marker>` — `server.environment` reached the Lambda (deploy) or the
 *   dev server's process env (dev).
 */
export default function Home() {
  const env =
    (typeof process !== "undefined" && process.env?.SOLIDSTART_ENV_MARKER) ||
    "env-not-set";
  // Single interpolated strings: Solid's SSR compiler inserts `<!--$-->`
  // hydration markers between adjacent children, which would split `config:`
  // from its value in the rendered HTML the tests grep.
  return (
    <main>
      <h1>SOLIDSTART_AWS_PAGE_MARKER</h1>
      <p>{`config:${__FIXTURE_MARKER__}`}</p>
      <p>{`env:${env}`}</p>
    </main>
  );
}
