/** @jsxImportSource react */
import { getEnv } from "waku";
import { Counter } from "../components/Counter.tsx";

export default async function HomePage() {
  // `getEnv` reads the Worker env the Cloudflare adapter registers at
  // request time (`setAllEnv(env)` in the production fetch handler) — the
  // portable way to reach bindings from RSC page modules. A top-level
  // `import { env } from "cloudflare:workers"` would break the Node-side
  // SSG step, and a runtime dynamic import of `cloudflare:workers` is not
  // available on the deployed edge.
  const message = getEnv("MESSAGE") ?? "unset";
  return (
    <div>
      <div data-testid="page-marker">WAKU_PAGE_MARKER</div>
      {/* Render one joined string — separate static/dynamic children would
          be split by an HTML comment in the SSR output, breaking plain
          body-substring assertions. */}
      <div data-testid="env-message">{`MESSAGE=${message}`}</div>
      <Counter />
    </div>
  );
}

// Dynamic so the worker must render it at request time (exercises the RSC
// server bundle + the env binding on the live edge).
export const getConfig = async () => ({ render: "dynamic" }) as const;
