/**
 * HTTP routes for the CostTracker ledger.
 *
 * One endpoint for now: `GET /api/cost/summary?threadId=X` returning the
 * live CostSummary (session + month + all-time). The client refetches on
 * each turn.completed activity; no WS push needed for v1 since the user
 * watching their own session is already on a refresh cadence driven by
 * the orchestration event stream.
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { CostTrackerService } from "./Services/CostTracker.ts";
import { localMonthKey } from "./types.ts";

export const costSummaryRouteLayer = HttpRouter.add(
  "GET",
  "/api/cost/summary",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    yield* serverAuth.authenticateHttpRequest(request);

    const tracker = yield* CostTrackerService;

    const url = HttpServerRequest.toURL(request);
    const threadId = (() => {
      if (url._tag === "None") return undefined;
      const raw = url.value.searchParams.get("threadId");
      return typeof raw === "string" && raw.length > 0 ? raw : undefined;
    })();

    const summary = yield* tracker.getSummary({
      threadId,
      at: new Date(),
    });

    return HttpServerResponse.jsonUnsafe(
      {
        monthKey: summary.monthKey ?? localMonthKey(),
        thread: summary.thread,
        month: summary.month,
        allTime: summary.allTime,
      },
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);
