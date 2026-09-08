import type * as EntrySsr from "./entry.ssr";
import { fetchServer } from "./entry.rsc";

// The distilled Cloudflare worker wrapper expects a `{ fetch }` default export.
// The worker runs in the `rsc` environment and loads the `ssr` environment at
// runtime to render HTML from the RSC payload.
export default {
  async fetch(request: Request): Promise<Response> {
    const ssr = await import.meta.viteRsc.loadModule<typeof EntrySsr>("ssr", "index");
    return ssr.default(request, await fetchServer(request));
  },
};
