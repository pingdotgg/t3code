import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

declare const __FIXTURE_MARKER__: string;

/**
 * Runs on the server for both the SSR render and client navigations, so the
 * markers below are always produced by the deployed Lambda (or, under
 * `alchemy dev`, by the Vite dev server).
 */
const getServerInfo = createServerFn({ method: "GET" }).handler(() => ({
  config: __FIXTURE_MARKER__,
  env: process.env.TANSTACK_ENV_MARKER ?? "env-not-set",
}));

export const Route = createFileRoute("/")({
  loader: () => getServerInfo(),
  component: Home,
});

/**
 * SSR home page. Renders three markers the live and local tests assert on:
 *
 * - `TANSTACK_AWS_PAGE_MARKER` — the page was server-rendered at all.
 * - `config:<marker>` — the fixture's own `vite.config.ts` `define` applied.
 * - `env:<marker>` — `server.environment` reached the Lambda (deploy) or the
 *   dev server's process env (dev).
 */
function Home() {
  const data = Route.useLoaderData();
  // Single interpolated strings: React inserts a `<!-- -->` text separator
  // between adjacent children, which would split `config:` from its value in
  // the rendered HTML the tests grep.
  return (
    <main>
      <h1>TANSTACK_AWS_PAGE_MARKER</h1>
      <p>{`config:${data.config}`}</p>
      <p>{`env:${data.env}`}</p>
    </main>
  );
}
