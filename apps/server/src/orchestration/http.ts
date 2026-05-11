import {
  ClientOrchestrationCommand,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  type OrchestrationReadModel,
} from "@forma/contracts";
import { Effect } from "effect";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { respondToAuthError } from "../auth/http.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const respondToOrchestrationHttpError = (
  error: OrchestrationDispatchCommandError | OrchestrationGetSnapshotError,
) =>
  Effect.gen(function* () {
    if (error._tag === "OrchestrationGetSnapshotError") {
      yield* Effect.logError("orchestration http route failed", {
        message: error.message,
        cause: error.cause,
      });
      return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 500 });
    }

    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 400 });
  });

const authenticateOwnerSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  if (session.role !== "owner") {
    return yield* new OrchestrationDispatchCommandError({
      message: "Only owner sessions can manage projects.",
    });
  }
  return session;
});

export const orchestrationSnapshotRouteLayer = HttpRouter.add(
  "GET",
  "/api/orchestration/snapshot",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const snapshot = yield* projectionSnapshotQuery.getSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationGetSnapshotError({
            message: "Failed to load orchestration snapshot.",
            cause,
          }),
      ),
    );
    return HttpServerResponse.jsonUnsafe(snapshot satisfies OrchestrationReadModel, {
      status: 200,
    });
  }).pipe(
    Effect.catchTag("OrchestrationDispatchCommandError", respondToOrchestrationHttpError),
    Effect.catchTag("OrchestrationGetSnapshotError", respondToOrchestrationHttpError),
  ),
);

export const orchestrationDispatchRouteLayer = HttpRouter.add(
  "POST",
  "/api/orchestration/dispatch",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const command = yield* HttpServerRequest.schemaBodyJson(ClientOrchestrationCommand).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Invalid orchestration command payload.",
            cause,
          }),
      ),
    );
    const normalizedCommand = yield* normalizeDispatchCommand(command);
    const result = yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Failed to dispatch orchestration command.",
            cause,
          }),
      ),
    );
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(Effect.catchTag("OrchestrationDispatchCommandError", respondToOrchestrationHttpError)),
);

function parseNonNegativeInteger(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export const orchestrationEventsRouteLayer = HttpRouter.add(
  "GET",
  "/api/orchestration/events",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;

    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = new URL(request.url, "http://localhost");
    const fromSequence = parseNonNegativeInteger(requestUrl.searchParams.get("fromSequence"));
    const heartbeatMs = Math.max(
      1_000,
      parseNonNegativeInteger(requestUrl.searchParams.get("heartbeatMs")) ?? 10_000,
    );
    const orchestrationEngine = yield* OrchestrationEngineService;
    const readModel = yield* orchestrationEngine.getReadModel();
    const liveEvents = orchestrationEngine.streamDomainEvents.pipe(
      Stream.map((event) => ({ type: "event" as const, event })),
    );
    const replayEvents =
      fromSequence === undefined
        ? Stream.empty
        : orchestrationEngine
            .readEvents(fromSequence)
            .pipe(Stream.map((event) => ({ type: "event" as const, event })));
    const heartbeatEvents = Stream.tick(`${heartbeatMs} millis`).pipe(
      Stream.drop(1),
      Stream.map(() => ({ type: "heartbeat" as const, at: new Date().toISOString() })),
    );

    return HttpServerResponse.stream(
      Stream.make({ type: "connected" as const, sequence: readModel.snapshotSequence }).pipe(
        Stream.concat(replayEvents),
        Stream.concat(Stream.merge(liveEvents, heartbeatEvents, { haltStrategy: "left" })),
        Stream.map(sseData),
        Stream.encodeText,
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }).pipe(
    Effect.catchTag("AuthError", (error: AuthError) => respondToAuthError(error)),
    Effect.catchTag("OrchestrationDispatchCommandError", respondToOrchestrationHttpError),
  ),
);
