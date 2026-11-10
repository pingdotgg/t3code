import { json } from "@sveltejs/kit";

const WIDGETS = [
  { id: "w1", name: "sprocket" },
  { id: "w2", name: "flange" },
  { id: "w3", name: "grommet" },
];

/**
 * A server endpoint in a pure-SPA app: pages are `ssr = false`, but
 * `+server.ts` endpoints still execute server-side (in the worker live, in
 * kit's Node dev server in dev) with access to `platform.env`.
 */
export const GET = ({ platform }: { platform?: App.Platform }) =>
  json({
    server: true,
    message: platform?.env?.FIXTURE_MESSAGE ?? null,
    widgets: WIDGETS,
  });
