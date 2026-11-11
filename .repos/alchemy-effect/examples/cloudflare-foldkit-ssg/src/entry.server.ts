import { Effect, Option } from "effect";
import { Server } from "foldkit/experimental";
import * as Url from "foldkit/url";
import { init, view } from "./main";
import { urlToAppRoute } from "./route";

export const renderDocument = Server.renderDocument;
export { prerenderPaths } from "./route";

export const renderPage = (request: Request): Promise<Server.EntryResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (urlToAppRoute(Option.getOrThrow(Url.fromString(request.url)))._tag === "NotFound") {
        return Server.Responded(new Response("Not Found", { status: 404 }));
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return Server.Responded(
          new Response(null, { status: 405, headers: { allow: "GET, HEAD" } }),
        );
      }
      const renderedApplication = yield* Server.renderToString(
        { routing: {}, init, view },
        { url: request.url },
      );

      return Server.Rendered(renderedApplication);
    }),
  );
