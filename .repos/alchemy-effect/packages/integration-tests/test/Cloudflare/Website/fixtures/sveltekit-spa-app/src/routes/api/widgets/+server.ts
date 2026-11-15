import { json } from "@sveltejs/kit";

// Local Platform shape — kit's generated types only exist after
// `svelte-kit sync`; this fixture is type-checked by the alchemy test
// project without a kit build.
interface Platform {
  env?: { TEST_BINDING?: string };
}

const WIDGETS = [
  { id: "w1", name: "sprocket" },
  { id: "w2", name: "flange" },
  { id: "w3", name: "grommet" },
];

/**
 * A server endpoint in a pure-SPA app: pages are `ssr = false`, but
 * `+server.ts` endpoints still execute server-side in the worker with
 * access to `platform.env`.
 */
export const GET = ({ platform }: { platform?: Platform }) =>
  json({
    server: true,
    message: platform?.env?.TEST_BINDING ?? null,
    widgets: WIDGETS,
  });
