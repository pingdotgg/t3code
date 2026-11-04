import { Effect } from "effect";
import { Server } from "foldkit/experimental";
import { Flags, init, view } from "./main.ts";

export { prerenderPaths } from "./prerender.ts";

export const renderDocument = Server.renderDocument;

const flagsForRequest = (request: Request): Flags => {
  const raw = new URL(request.url).searchParams.get("count");
  const parsed = raw === null ? Number.NaN : Number(raw);
  return { initialCount: Number.isFinite(parsed) ? parsed : 0 };
};

// SSG: the build renders the prerendered pages; at runtime the handler only
// answers what is not a page.
export const renderPage = (request: Request): Promise<Server.EntryResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
      if (pathname !== "/" && pathname !== "/about")
        return Server.Responded(new Response("Not Found", { status: 404 }));
      if (request.method !== "GET" && request.method !== "HEAD")
        return Server.Responded(
          new Response(null, { status: 405, headers: { allow: "GET, HEAD" } }),
        );
      const application = yield* Server.renderToString(
        { Flags, init, view },
        { flags: flagsForRequest(request) },
      );
      return Server.Rendered(application);
    }),
  );
