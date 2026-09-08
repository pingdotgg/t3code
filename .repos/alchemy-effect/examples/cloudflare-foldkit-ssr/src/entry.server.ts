import { Effect } from "effect";
import { Server } from "foldkit/experimental";

import { Flags, init, view } from "./main.ts";

// THE SERVER ENTRY — one Web Request in, one delivery result out. The Worker
// places the result into the HTML shell; nothing here knows who called it.
// The same entry is what a build-time prerender would call.

// The count comes off the query string purely so the render has something
// request-shaped to do: `/?count=7` serves a 7 before any JavaScript runs.
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
          buildId: import.meta.env.FOLDKIT_BUILD_ID,
        },
      );
      return Server.Rendered(application);
    }),
  );
