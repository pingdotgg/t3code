import { Effect, Option } from "effect";
import { Server } from "foldkit/experimental";
import * as Url from "foldkit/url";
import { Flags, init, view } from "./main";
import { urlToAppRoute } from "./route";

export const renderDocument = Server.renderDocument;
export { prerenderPaths } from "./route";

export const renderPage = (request: Request): Promise<Server.EntryResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const url = new URL(request.url);
      const route = urlToAppRoute(Option.getOrThrow(Url.fromString(request.url)));
      if (route._tag === "NotFound") {
        return Server.Responded(new Response("Not Found", { status: 404 }));
      }
      const count = Number(url.searchParams.get("count") ?? 0);
      const renderedApplication = yield* Server.renderToString(
        { routing: {}, Flags, init, view },
        {
          url: request.url,
          flags: { initialCount: Number.isSafeInteger(count) ? count : 0 },
        },
      );

      return route._tag === "Counter"
        ? Server.Rendered(renderedApplication, {
            headers: { "cache-control": "private, no-store" },
          })
        : Server.Rendered(renderedApplication);
    }),
  );
