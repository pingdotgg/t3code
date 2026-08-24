import * as IVSRealtime from "@/AWS/IVSRealtime";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/** The user ID the fixture mints participant tokens for. */
export const TEST_USER_ID = "alchemy-test-user";

/**
 * A well-formed participant id that does not exist — participant/session
 * routes prove end-to-end wiring by observing the API's typed response.
 */
const MISSING_PARTICIPANT_ID = "abcDEF123456";
/** A well-formed stage session id that does not exist. */
const MISSING_SESSION_ID = "st-0000AbCd0000";

export class IVSRealtimeTestFunction extends Lambda.Function<Lambda.Function>()(
  "IVSRealtimeTestFunction",
) {}

export default IVSRealtimeTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const stage = yield* IVSRealtime.Stage("BindingsStage", {
      stageName: "alchemy-test-ivsrealtime-bindings",
      tags: { fixture: "ivsrealtime-bindings" },
    });
    const overflowStage = yield* IVSRealtime.Stage("BindingsOverflowStage", {
      stageName: "alchemy-test-ivsrealtime-bindings-b",
      tags: { fixture: "ivsrealtime-bindings" },
    });

    // Event source: subscribe the host to IVS Real-Time stage updates and
    // composition state changes. The deploy proves the EventBridge rule +
    // invoke permission wiring.
    yield* IVSRealtime.consumeStageEvents(
      { kinds: ["stage-update", "composition-state-change"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `ivs stage event: ${event.detail.event_name} (${event.detail.participant_id})`,
          ),
        ),
    );

    const createParticipantToken =
      yield* IVSRealtime.CreateParticipantToken(stage);
    const disconnectParticipant =
      yield* IVSRealtime.DisconnectParticipant(stage);
    const getParticipant = yield* IVSRealtime.GetParticipant(stage);
    const listParticipants = yield* IVSRealtime.ListParticipants(stage);
    const listParticipantEvents =
      yield* IVSRealtime.ListParticipantEvents(stage);
    const listParticipantReplicas =
      yield* IVSRealtime.ListParticipantReplicas(stage);
    const getStageSession = yield* IVSRealtime.GetStageSession(stage);
    const listStageSessions = yield* IVSRealtime.ListStageSessions(stage);
    const startParticipantReplication =
      yield* IVSRealtime.StartParticipantReplication(stage, overflowStage);
    const stopParticipantReplication =
      yield* IVSRealtime.StopParticipantReplication(stage, overflowStage);
    const startComposition = yield* IVSRealtime.StartComposition(stage);
    const stopComposition = yield* IVSRealtime.StopComposition();
    const getComposition = yield* IVSRealtime.GetComposition();
    const listCompositions = yield* IVSRealtime.ListCompositions();

    const bound = {
      createParticipantToken,
      disconnectParticipant,
      getParticipant,
      listParticipants,
      listParticipantEvents,
      listParticipantReplicas,
      getStageSession,
      listStageSessions,
      startParticipantReplication,
      stopParticipantReplication,
      startComposition,
      stopComposition,
      getComposition,
      listCompositions,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        if (request.method === "POST" && pathname === "/token") {
          const { participantToken } = yield* createParticipantToken({
            userId: TEST_USER_ID,
            capabilities: ["PUBLISH", "SUBSCRIBE"],
            // Exercises the Duration.Input -> wire minutes conversion.
            duration: "30 minutes",
            attributes: { displayName: "Alchemy" },
          });
          // The token is sensitive — assert on its shape, never echo it.
          const token = participantToken?.token;
          const tokenLength =
            token === undefined
              ? 0
              : Redacted.isRedacted(token)
                ? Redacted.value(token).length
                : token.length;
          return yield* HttpServerResponse.json({
            tokenLength,
            tokenIsRedacted: token !== undefined && Redacted.isRedacted(token),
            participantId: participantToken?.participantId,
            duration: participantToken?.duration,
            expirationTime: participantToken?.expirationTime,
          });
        }

        if (request.method === "POST" && pathname === "/disconnect") {
          const result = yield* disconnectParticipant({
            participantId: MISSING_PARTICIPANT_ID,
            reason: "alchemy test",
          }).pipe(
            Effect.map(() => ({ ok: true })),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/sessions") {
          const { stageSessions } = yield* listStageSessions();
          return yield* HttpServerResponse.json({
            count: stageSessions.length,
          });
        }

        if (request.method === "GET" && pathname === "/session-missing") {
          const result = yield* getStageSession({
            sessionId: MISSING_SESSION_ID,
          }).pipe(
            Effect.map(() => ({ found: true })),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/participants") {
          const result = yield* listParticipants({
            sessionId: MISSING_SESSION_ID,
          }).pipe(
            Effect.map((r) => ({ count: r.participants.length })),
            Effect.catchTag("ValidationException", (e) =>
              Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/participant-missing") {
          const result = yield* getParticipant({
            sessionId: MISSING_SESSION_ID,
            participantId: MISSING_PARTICIPANT_ID,
          }).pipe(
            Effect.map(() => ({ found: true })),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/participant-events") {
          const result = yield* listParticipantEvents({
            sessionId: MISSING_SESSION_ID,
            participantId: MISSING_PARTICIPANT_ID,
          }).pipe(
            Effect.map((r) => ({ count: r.events.length })),
            Effect.catchTag("ValidationException", (e) =>
              Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/replicas") {
          const result = yield* listParticipantReplicas({
            participantId: MISSING_PARTICIPANT_ID,
          }).pipe(
            Effect.map((r) => ({ count: r.replicas.length })),
            Effect.catchTag("ValidationException", (e) =>
              Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/replication-start") {
          const result = yield* startParticipantReplication({
            participantId: MISSING_PARTICIPANT_ID,
            reconnectWindow: "30 seconds",
          }).pipe(
            Effect.map(() => ({ ok: true })),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "ValidationException",
                "ConflictException",
                "PendingVerification",
                "ServiceQuotaExceededException",
              ],
              (e) => Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/replication-stop") {
          const result = yield* stopParticipantReplication({
            participantId: MISSING_PARTICIPANT_ID,
          }).pipe(
            Effect.map(() => ({ ok: true })),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/compositions") {
          const { compositions } = yield* listCompositions();
          return yield* HttpServerResponse.json({
            count: compositions.length,
          });
        }

        // Composition routes take a well-formed-but-nonexistent ARN from the
        // test (the test knows the region/account) and prove wiring by
        // observing the API's typed response.
        if (request.method === "GET" && pathname === "/composition-missing") {
          const arn = url.searchParams.get("arn")!;
          const result = yield* getComposition({ arn }).pipe(
            Effect.map(() => ({ found: true })),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/composition-stop") {
          const arn = url.searchParams.get("arn")!;
          const result = yield* stopComposition({ arn }).pipe(
            Effect.map(() => ({ ok: true })),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/composition-start") {
          const storageConfigurationArn = url.searchParams.get("arn")!;
          const result = yield* startComposition({
            destinations: [
              {
                s3: {
                  storageConfigurationArn,
                  encoderConfigurationArns: [],
                },
              },
            ],
          }).pipe(
            Effect.map((r) => ({ ok: true, arn: r.composition?.arn })),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "ValidationException",
                "ConflictException",
                "PendingVerification",
                "ServiceQuotaExceededException",
              ],
              (e) => Effect.succeed({ tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        IVSRealtime.CreateParticipantTokenHttp,
        IVSRealtime.DisconnectParticipantHttp,
        IVSRealtime.GetParticipantHttp,
        IVSRealtime.ListParticipantsHttp,
        IVSRealtime.ListParticipantEventsHttp,
        IVSRealtime.ListParticipantReplicasHttp,
        IVSRealtime.GetStageSessionHttp,
        IVSRealtime.ListStageSessionsHttp,
        IVSRealtime.StartParticipantReplicationHttp,
        IVSRealtime.StopParticipantReplicationHttp,
        IVSRealtime.StartCompositionHttp,
        IVSRealtime.StopCompositionHttp,
        IVSRealtime.GetCompositionHttp,
        IVSRealtime.ListCompositionsHttp,
      ),
    ),
  ),
);
