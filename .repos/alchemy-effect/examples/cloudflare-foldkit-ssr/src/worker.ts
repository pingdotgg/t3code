import { Server } from "foldkit/experimental";

import { renderPage } from "./entry.server.ts";

// Minimal binding shape, so the example needs no Workers type package.
interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
}

// THE SHELL — the BUILT index.html, read from the assets binding rather than
// imported from source. The source template names `/src/entry.ts`; the built
// one names the hashed bundle, and it is the only copy that cannot disagree
// with what the browser will be asked to load.
const shell = (env: Env, url: URL): Promise<string> =>
  env.ASSETS.fetch(new Request(new URL("/index.html", url.origin))).then(
    (response) => response.text(),
  );

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // A method the `Request` constructor rejects can never reach an entry, so
    // it is refused here rather than becoming a 500 further in.
    if (Server.isHostSettledMethod(request.method)) {
      return new Response(null, {
        status: Server.HOST_METHOD_ANSWERS.refusedStatus,
        headers: { Allow: Server.HOST_METHOD_ANSWERS.allow },
      });
    }

    // A request that matched no file is not automatically a page. Browsers
    // ask for scripts and images with `Accept: */*`, which accepts HTML, so a
    // hashed bundle that is no longer deployed would otherwise be answered
    // with the shell at 200 — a stale client would read that as its own
    // JavaScript. Classifying the miss answers it as the miss it is.
    const classification = Server.classifyRequest(
      request.url,
      request.headers.get("sec-fetch-dest") ?? undefined,
    );
    if (classification !== "Page") {
      return new Response("Not found", { status: 404 });
    }

    const url = new URL(request.url);
    return Server.toResponse(await shell(env, url), await renderPage(request));
  },
};
