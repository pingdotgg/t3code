import { Effect } from "effect";
import { Server } from "foldkit/experimental";
import { readCountCookie } from "./cookie";
import { Flags, init, view } from "./main";

export const renderDocument = Server.renderDocument;

const flagsForRequest = (cookieHeader: string): Flags => ({
  initialCount: readCountCookie(cookieHeader),
  renderedAt: new Date().toISOString(),
  renderedOn: "Server",
});

// NOTE: the Flags built from this request are serialized into the rendered
// HTML and travel to the browser with it. The hydrating client reads them
// back and calls init with the exact values this render used; the client
// computes no Flags of its own.
// NOTE: a preflight reaches this entry in development and in production alike,
// so an application's CORS policy goes here rather than in the host: it can
// allow one origin for one route and refuse it for another. This answer allows
// nothing and only reports which methods the host forwards.
const preflightResponse = (): Response =>
  new Response(null, {
    status: 204,
    headers: { allow: Server.HOST_METHOD_ANSWERS.allow },
  });

export const renderPage = (request: Request): Promise<Server.EntryResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (request.method === "OPTIONS") {
        return Server.Responded(preflightResponse());
      }

      const renderedApplication = yield* Server.renderToString(
        { Flags, init, view },
        {
          flags: flagsForRequest(request.headers.get("cookie") ?? ""),
        },
      );

      return Server.Rendered(renderedApplication, {
        headers: {
          "cache-control": "private, no-store",
          vary: "cookie",
          "x-content-type-options": "nosniff",
        },
      });
    }),
  );
