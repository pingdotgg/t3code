import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { authenticateRawRouteWithScope } from "../http.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(snapshot.value);
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          return yield* orchestrationEngine
            .dispatch(normalizedCommand)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
        }),
      );
  }),
);

function parseNonNegativeInteger(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Authenticated read-only Server-Sent Events stream of orchestration domain
 * events (Forma). Supports `?fromSequence=<n>` replay from a persisted
 * sequence cursor and `?heartbeatMs=<n>` keep-alive tuning. Surfaced in
 * Settings → Safety as a debugging endpoint.
 */
export const orchestrationEventsRouteLayer = HttpRouter.add(
  "GET",
  "/api/orchestration/events",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);

    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = new URL(request.url, "http://localhost");
    const fromSequence = parseNonNegativeInteger(requestUrl.searchParams.get("fromSequence"));
    const heartbeatMs = Math.max(
      1_000,
      parseNonNegativeInteger(requestUrl.searchParams.get("heartbeatMs")) ?? 10_000,
    );
    const orchestrationEngine = yield* OrchestrationEngineService;
    const latestSequence = yield* orchestrationEngine.latestSequence;
    const liveEvents = orchestrationEngine.streamDomainEvents.pipe(
      Stream.map((event) => ({ type: "event" as const, event })),
    );
    const replayEvents =
      fromSequence === undefined
        ? Stream.empty
        : orchestrationEngine.readEvents(fromSequence).pipe(
            Stream.map((event) => ({ type: "event" as const, event })),
            Stream.catch(() => Stream.empty),
          );
    const heartbeatEvents = Stream.tick(`${heartbeatMs} millis`).pipe(
      Stream.drop(1),
      Stream.mapEffect(() =>
        Effect.map(DateTime.now, (now) => ({
          type: "heartbeat" as const,
          at: DateTime.formatIso(now),
        })),
      ),
    );

    return HttpServerResponse.stream(
      Stream.make({ type: "connected" as const, sequence: latestSequence }).pipe(
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
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
