import * as IVSChat from "@/AWS/IVSChat";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/** The user ID the fixture mints tokens for and disconnects. */
export const TEST_USER_ID = "alchemy-test-user";

export class IVSChatTestFunction extends Lambda.Function<Lambda.Function>()(
  "IVSChatTestFunction",
) {}

export default IVSChatTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const room = yield* IVSChat.Room("BindingsRoom", {
      roomName: "alchemy-test-ivschat-bindings",
      tags: { fixture: "ivschat-bindings" },
    });

    const createChatToken = yield* IVSChat.CreateChatToken(room);
    const sendEvent = yield* IVSChat.SendEvent(room);
    const deleteMessage = yield* IVSChat.DeleteMessage(room);
    const disconnectUser = yield* IVSChat.DisconnectUser(room);

    // Message review handler: deny messages containing "deny-me"; stamp
    // everything else with a marker so the test can observe the review.
    yield* IVSChat.onReviewMessage(room, (event) =>
      Effect.succeed(
        event.Content.includes("deny-me")
          ? {
              ReviewResult: "DENY" as const,
              Attributes: { Reason: "alchemy-moderated" },
            }
          : {
              ReviewResult: "ALLOW" as const,
              Content: `${event.Content} [reviewed]`,
            },
      ),
    );

    const RoomArn = yield* room.roomArn;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/token") {
          const result = yield* createChatToken({
            userId: TEST_USER_ID,
            capabilities: ["SEND_MESSAGE"],
            // Exercises the Duration.Input -> sessionDurationInMinutes wiring.
            sessionDuration: "30 minutes",
            attributes: { displayName: "Alchemy" },
          });
          // The token is sensitive — assert on its shape, never echo it.
          const token = result.token;
          const tokenLength =
            token === undefined
              ? 0
              : Redacted.isRedacted(token)
                ? Redacted.value(token).length
                : token.length;
          return yield* HttpServerResponse.json({
            tokenLength,
            tokenIsRedacted: token !== undefined && Redacted.isRedacted(token),
            tokenExpirationTime: result.tokenExpirationTime,
            sessionExpirationTime: result.sessionExpirationTime,
          });
        }

        if (request.method === "POST" && pathname === "/ws-info") {
          // The test drives the room's WebSocket messaging API directly to
          // exercise the message review handler; it needs the raw token
          // (scoped to this test room, 30-minute session) and the regional
          // edge endpoint.
          const result = yield* createChatToken({
            userId: TEST_USER_ID,
            capabilities: ["SEND_MESSAGE"],
            sessionDuration: "30 minutes",
          });
          const token = result.token;
          const raw =
            token === undefined
              ? undefined
              : Redacted.isRedacted(token)
                ? Redacted.value(token)
                : token;
          const region = yield* Effect.sync(() => process.env.AWS_REGION);
          const roomArn = yield* RoomArn;
          return yield* HttpServerResponse.json({
            token: raw,
            endpoint: `wss://edge.ivschat.${region}.amazonaws.com`,
            roomArn,
          });
        }

        if (request.method === "POST" && pathname === "/send-event") {
          const { id } = yield* sendEvent({
            eventName: "app:announcement",
            attributes: { note: "hello from alchemy" },
          });
          return yield* HttpServerResponse.json({ id });
        }

        if (request.method === "POST" && pathname === "/delete-message") {
          // Broadcast an event first and use its ID as the deletion target —
          // DeleteMessage broadcasts a DELETEMESSAGE event and succeeds
          // whether or not clients hold the message.
          const sent = yield* sendEvent({ eventName: "app:to-delete" });
          const { id } = yield* deleteMessage({
            id: sent.id!,
            reason: "moderated by alchemy test",
          });
          return yield* HttpServerResponse.json({ deleted: id });
        }

        if (request.method === "POST" && pathname === "/disconnect-user") {
          yield* disconnectUser({
            userId: TEST_USER_ID,
            reason: "alchemy test",
          });
          return yield* HttpServerResponse.json({ ok: true });
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
        IVSChat.CreateChatTokenHttp,
        IVSChat.SendEventHttp,
        IVSChat.DeleteMessageHttp,
        IVSChat.DisconnectUserHttp,
        Lambda.RoomMessageReviewEventSource,
      ),
    ),
  ),
);
