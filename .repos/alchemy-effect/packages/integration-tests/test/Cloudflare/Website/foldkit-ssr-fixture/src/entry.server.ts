import { Effect } from "effect";
import { Server } from "foldkit/experimental";
import { Flags, init, view } from "./main.ts";

export { prerenderPaths } from "./prerender.ts";

// The count comes off the query string so a render has something
// request-shaped in it: a page served from a prerendered file shows the
// count it was built with, a page rendered on request shows the query's.
export const renderDocument = Server.renderDocument;

const flagsForRequest = (request: Request): Flags => {
  const raw = new URL(request.url).searchParams.get("count");
  const parsed = raw === null ? Number.NaN : Number(raw);
  return { initialCount: Number.isFinite(parsed) ? parsed : 0 };
};

export const renderPage = (request: Request): Promise<Server.EntryResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const application = yield* Server.renderToString(
        { Flags, init, view },
        {
          flags: flagsForRequest(request),
        },
      );
      return Server.Rendered(application);
    }),
  );
