import * as ivschat from "@distilled.cloud/aws/ivschat";
import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import WebSocket from "ws";

import IVSChatTestFunctionLive, {
  IVSChatTestFunction,
} from "./fixtures/handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "IVSChatBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(60),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class WsFailure extends Data.TaggedError("WsFailure")<{
  readonly reason: string;
}> {}

const post = (path: string) =>
  HttpClient.execute(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(5),
      ]),
    }),
  );

describe("IVSChat Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "IVSChat test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("IVSChat test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* IVSChatTestFunction;
        }).pipe(Effect.provide(IVSChatTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `IVSChat test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `IVSChat test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("IVSChat.CreateChatToken", () => {
    test.provider(
      "mints a redacted chat token honoring sessionDuration",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* post("/token").pipe(
            Effect.flatMap((r) => r.json),
          )) as {
            tokenLength: number;
            tokenIsRedacted: boolean;
            tokenExpirationTime?: string;
            sessionExpirationTime?: string;
          };

          expect(response.tokenLength).toBeGreaterThan(0);
          // SensitiveString in distilled decodes to a Redacted value.
          expect(response.tokenIsRedacted).toBe(true);
          expect(response.tokenExpirationTime).toBeTruthy();
          expect(response.sessionExpirationTime).toBeTruthy();

          // sessionDuration: "30 minutes" must reach the wire as
          // sessionDurationInMinutes: 30 (the API default is 60).
          const sessionMinutes =
            (new Date(response.sessionExpirationTime!).getTime() - Date.now()) /
            60_000;
          expect(sessionMinutes).toBeGreaterThan(20);
          expect(sessionMinutes).toBeLessThan(40);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSChat.SendEvent", () => {
    test.provider(
      "broadcasts an application event to the room",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* post("/send-event").pipe(
            Effect.flatMap((r) => r.json),
          )) as { id?: string };

          expect(typeof response.id).toBe("string");
          expect(response.id!.length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSChat.DeleteMessage", () => {
    test.provider(
      "broadcasts a DELETEMESSAGE moderation event",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* post("/delete-message").pipe(
            Effect.flatMap((r) => r.json),
          )) as { deleted?: string };

          expect(typeof response.deleted).toBe("string");
          expect(response.deleted!.length).toBeGreaterThan(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSChat.RoomMessageReviewEventSource", () => {
    /**
     * The IVS Chat messaging wire format is PascalCase — send
     * `{Action, Content, RequestId}`, receive `{Type, Content, ErrorCode,
     * ErrorMessage}` frames.
     */
    interface ChatFrame {
      Type: string;
      Content?: string;
      ErrorCode?: number;
      ErrorMessage?: string;
    }

    /**
     * Connect to the room's WebSocket messaging endpoint with a chat token,
     * send one message, and resolve with the first frame the room sends
     * back for it (`MESSAGE` when the review handler allows, `ERROR` when
     * it denies). Encapsulated in `Effect.callback` so fiber interruption
     * closes the socket.
     */
    const wsSendMessage = (endpoint: string, token: string, content: string) =>
      Effect.callback<ChatFrame, WsFailure>((resume, signal) => {
        const socket = new WebSocket(endpoint, token);
        let settled = false;
        const settle = (effect: Effect.Effect<ChatFrame, WsFailure>) => {
          if (settled) return;
          settled = true;
          try {
            socket.close();
          } catch {
            // already closed
          }
          resume(effect);
        };
        signal.addEventListener("abort", () =>
          settle(Effect.fail(new WsFailure({ reason: "interrupted" }))),
        );
        socket.on("open", () =>
          socket.send(
            JSON.stringify({
              Action: "SEND_MESSAGE",
              RequestId: "alchemy-review-test",
              Content: content,
            }),
          ),
        );
        socket.on("message", (data) => {
          let frame: ChatFrame;
          try {
            frame = JSON.parse(String(data));
          } catch {
            return; // ignore unparsable frames
          }
          // MESSAGE (delivered) and ERROR (denied) both settle the probe;
          // ignore unrelated frames (e.g. other EVENTs).
          if (frame.Type === "MESSAGE" || frame.Type === "ERROR") {
            settle(Effect.succeed(frame));
          }
        });
        socket.on("error", (error) =>
          settle(Effect.fail(new WsFailure({ reason: String(error) }))),
        );
        socket.on("close", (code) =>
          settle(
            Effect.fail(new WsFailure({ reason: `closed early (${code})` })),
          ),
        );
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(new WsFailure({ reason: "no frame within 15s" })),
        ),
      );

    const wsInfo = Effect.gen(function* () {
      const info = (yield* post("/ws-info").pipe(
        Effect.flatMap((r) => r.json),
      )) as { token?: string; endpoint?: string; roomArn?: string };
      expect(info.token).toBeTruthy();
      expect(info.endpoint).toContain("wss://edge.ivschat.");
      return info as { token: string; endpoint: string; roomArn: string };
    });

    test.provider(
      "associates the handler + invoke permission on deploy",
      (_stack) =>
        Effect.gen(function* () {
          const { roomArn } = yield* wsInfo;
          // Out-of-band: the deployed room must carry the fixture Lambda as
          // its messageReviewHandler (set through the binding contract).
          const room = yield* ivschat.getRoom({ identifier: roomArn });
          expect(room.messageReviewHandler?.uri).toContain(":function:");
          expect(room.messageReviewHandler?.fallbackResult ?? "ALLOW").toBe(
            "ALLOW",
          );
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "review handler modifies allowed messages",
      (_stack) =>
        Effect.gen(function* () {
          // The handler association + invoke Permission propagate shortly
          // after deploy; until then IVS Chat's fallbackResult (ALLOW)
          // delivers the ORIGINAL content — treat that as retryable.
          const frame = yield* Effect.gen(function* () {
            const { token, endpoint } = yield* wsInfo;
            const received = yield* wsSendMessage(
              endpoint,
              token,
              "hello moderators",
            );
            if (
              received.Type !== "MESSAGE" ||
              !received.Content?.includes("[reviewed]")
            ) {
              return yield* Effect.fail(
                new WsFailure({
                  reason: `not yet reviewed: ${JSON.stringify(received)}`,
                }),
              );
            }
            return received;
          }).pipe(
            Effect.tapError((e) =>
              Effect.logInfo(
                `review-allow attempt failed: ${e._tag === "WsFailure" ? e.reason : String(e)}`,
              ),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("2 seconds"),
                Schedule.recurs(5),
              ]),
            }),
          );

          expect(frame.Type).toBe("MESSAGE");
          expect(frame.Content).toBe("hello moderators [reviewed]");
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "review handler denies flagged messages with a 406",
      (_stack) =>
        Effect.gen(function* () {
          const frame = yield* Effect.gen(function* () {
            const { token, endpoint } = yield* wsInfo;
            const received = yield* wsSendMessage(
              endpoint,
              token,
              "please deny-me now",
            );
            if (received.Type !== "ERROR") {
              return yield* Effect.fail(
                new WsFailure({
                  reason: `not yet denied: ${JSON.stringify(received)}`,
                }),
              );
            }
            return received;
          }).pipe(
            Effect.tapError((e) =>
              Effect.logInfo(
                `review-deny attempt failed: ${e._tag === "WsFailure" ? e.reason : String(e)}`,
              ),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("2 seconds"),
                Schedule.recurs(5),
              ]),
            }),
          );

          expect(frame.Type).toBe("ERROR");
          expect(frame.ErrorCode).toBe(406);
          expect(frame.ErrorMessage).toContain("alchemy-moderated");
        }),
      { timeout: 120_000 },
    );
  });

  describe("IVSChat.DisconnectUser", () => {
    test.provider(
      "disconnects a user's room connections",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* post("/disconnect-user").pipe(
            Effect.flatMap((r) => r.json),
          )) as { ok?: boolean };

          expect(response.ok).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });
});
