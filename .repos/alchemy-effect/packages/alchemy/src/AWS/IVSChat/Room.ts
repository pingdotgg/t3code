import * as ivschat from "@distilled.cloud/aws/ivschat";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  retryWhileHandlerPermissionPropagating,
  retryWhileThrottled,
  syncIvsChatTags,
  toTagRecord,
} from "./internal.ts";

export interface RoomMessageReviewHandler {
  /**
   * ARN of the Lambda function that reviews messages before they are
   * delivered to the room.
   */
  uri?: string;
  /**
   * What happens to a message if the review handler errors or times out:
   * `ALLOW` delivers it, `DENY` drops it.
   * @default "ALLOW"
   */
  fallbackResult?: "ALLOW" | "DENY";
}

/**
 * The binding contract of a room: the message review event source
 * (`IVSChat.onReviewMessage`) contributes the reviewing Lambda's ARN as the
 * room's `messageReviewHandler`, which the provider merges with
 * `props.messageReviewHandler` and syncs onto the room.
 */
export interface RoomBinding {
  /** Review handler injected by `IVSChat.onReviewMessage`. */
  messageReviewHandler?: RoomMessageReviewHandler;
}

export interface RoomProps {
  /**
   * Name of the room (not unique). If omitted, a deterministic physical
   * name is generated. Room names are mutable — changing the name
   * updates the room in place.
   */
  roomName?: string;
  /**
   * Maximum number of messages per second that can be sent to the room
   * (`1` - `10`).
   * @default 10
   */
  maximumMessageRatePerSecond?: number;
  /**
   * Maximum number of characters in a single message (`1` - `500`).
   * @default 500
   */
  maximumMessageLength?: number;
  /**
   * A Lambda-backed handler that reviews (and can modify or deny)
   * messages before delivery. Prefer wiring it through
   * `IVSChat.onReviewMessage` — the event source also creates the invoke
   * Permission and registers the runtime handler.
   * @default no review handler
   */
  messageReviewHandler?: RoomMessageReviewHandler;
  /**
   * ARNs or IDs of `LoggingConfiguration`s that record the room's chat
   * messages.
   */
  loggingConfigurationIdentifiers?: string[];
  /**
   * Tags to apply to the room. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Room extends Resource<
  "AWS.IVSChat.Room",
  RoomProps,
  {
    /**
     * The room's physical name.
     */
    roomName: string;
    /**
     * ARN of the room.
     */
    roomArn: string;
    /**
     * Unique ID of the room.
     */
    roomId: string;
  },
  RoomBinding,
  Providers
> {}

/**
 * An Amazon IVS Chat room — a virtual space where chat participants
 * exchange messages over WebSocket connections.
 *
 * Clients connect with chat tokens minted at runtime via
 * `CreateChatToken`; message rate/length limits, a Lambda review handler,
 * and logging configurations are all managed on the room.
 * @resource
 * @section Creating Rooms
 * @example Basic Room
 * ```typescript
 * import * as IVSChat from "alchemy/AWS/IVSChat";
 *
 * const room = yield* IVSChat.Room("LiveChat");
 * ```
 *
 * @example Room with Message Limits
 * ```typescript
 * const room = yield* IVSChat.Room("LiveChat", {
 *   maximumMessageRatePerSecond: 5,
 *   maximumMessageLength: 200,
 * });
 * ```
 *
 * @section Logging
 * @example Room with Chat Logging
 * ```typescript
 * const logging = yield* IVSChat.LoggingConfiguration("ChatLogs", {
 *   destinationConfiguration: {
 *     cloudWatchLogs: { logGroupName: logGroup.logGroupName },
 *   },
 * });
 * const room = yield* IVSChat.Room("LiveChat", {
 *   loggingConfigurationIdentifiers: [logging.loggingConfigurationArn],
 * });
 * ```
 *
 * @section Message Review
 * @example Review Messages with a Lambda Handler
 * ```typescript
 * // inside a Lambda Function's effect — the handler reviews every message
 * // sent to the room before delivery (allow / modify / deny)
 * const room = yield* IVSChat.Room("LiveChat");
 * yield* IVSChat.onReviewMessage(room, (event) =>
 *   Effect.succeed(
 *     event.Content.includes("banned-word")
 *       ? { ReviewResult: "DENY", Attributes: { Reason: "moderated" } }
 *       : undefined,
 *   ),
 * );
 * // on the Function effect:
 * // .pipe(Effect.provide(Lambda.RoomMessageReviewEventSource))
 * ```
 */
export const Room = Resource<Room>("AWS.IVSChat.Room");

/**
 * Raised when the IVS Chat API returns a room missing its ARN, ID, or
 * name.
 */
export class IvsChatRoomIncomplete extends Data.TaggedError(
  "IvsChatRoomIncomplete",
)<{ message: string }> {}

/**
 * Two different Lambda functions were registered as the same room's message
 * review handler — IVS Chat supports exactly one handler per room.
 */
export class ConflictingRoomMessageReviewHandler extends Data.TaggedError(
  "ConflictingRoomMessageReviewHandler",
)<{ readonly uris: readonly string[] }> {}

/**
 * The room's desired `messageReviewHandler`: `props.messageReviewHandler`
 * merged with the handler contributed through the binding contract
 * (`IVSChat.onReviewMessage`). Fails when two different handler URIs are
 * declared. Returns `undefined` when no handler is desired (which clears
 * any associated handler on update).
 */
const resolveMessageReviewHandler = Effect.fn(function* (
  news: RoomProps,
  bindings: ReadonlyArray<RoomBinding | { data?: RoomBinding }>,
) {
  const contributions = [
    news.messageReviewHandler,
    ...bindings.map(
      (binding) =>
        (binding as { data?: RoomBinding }).data?.messageReviewHandler ??
        (binding as RoomBinding).messageReviewHandler,
    ),
  ].filter((handler) => handler !== undefined);
  let resolved: RoomMessageReviewHandler | undefined;
  for (const handler of contributions) {
    if (
      resolved?.uri !== undefined &&
      handler.uri !== undefined &&
      resolved.uri !== handler.uri
    ) {
      return yield* Effect.fail(
        new ConflictingRoomMessageReviewHandler({
          uris: [resolved.uri, handler.uri],
        }),
      );
    }
    resolved = { ...resolved, ...handler };
  }
  return resolved;
});

type RoomState = {
  arn?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  maximumMessageRatePerSecond?: number | undefined;
  maximumMessageLength?: number | undefined;
  messageReviewHandler?: ivschat.MessageReviewHandler | undefined;
  tags?: { [key: string]: string | undefined } | undefined;
  loggingConfigurationIdentifiers?: string[] | undefined;
};

export const RoomProvider = () =>
  Provider.effect(
    Room,
    Effect.gen(function* () {
      const toName = (id: string, props: RoomProps) =>
        props.roomName
          ? Effect.succeed(props.roomName)
          : createPhysicalName({ id, maxLength: 128 });

      const toAttrs = Effect.fn(function* (room: RoomState) {
        if (!room.arn || !room.id || !room.name) {
          return yield* Effect.fail(
            new IvsChatRoomIncomplete({
              message: "IVS Chat room is missing its ARN, ID, or name",
            }),
          );
        }
        return {
          roomName: room.name,
          roomArn: room.arn,
          roomId: room.id,
        };
      });

      const getByIdentifier = Effect.fn(function* (identifier: string) {
        return yield* ivschat.getRoom({ identifier }).pipe(
          retryWhileThrottled,
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      /** `ListRooms` filters by name server-side; match exactly. */
      const findByName = Effect.fn(function* (name: string) {
        const summaries = yield* ivschat.listRooms.pages({ name }).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) => page.rooms),
          ),
          retryWhileThrottled,
        );
        const match = summaries.find((s) => s.name === name && s.arn);
        return match?.arn ? yield* getByIdentifier(match.arn) : undefined;
      });

      return {
        stables: ["roomArn", "roomId"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const room = output?.roomArn
            ? yield* getByIdentifier(output.roomArn)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (room === undefined) return undefined;
          const attrs = yield* toAttrs(room);
          return (yield* hasAlchemyTags(id, toTagRecord(room.tags)))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          session,
          bindings,
        }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const messageReviewHandler = yield* resolveMessageReviewHandler(
            news,
            bindings,
          );

          // 1. Observe.
          let observed: RoomState | undefined = output?.roomArn
            ? yield* getByIdentifier(output.roomArn)
            : yield* findByName(name);

          // 2. Ensure — create if missing.
          if (observed === undefined) {
            observed = yield* ivschat
              .createRoom({
                name,
                maximumMessageRatePerSecond: news.maximumMessageRatePerSecond,
                maximumMessageLength: news.maximumMessageLength,
                messageReviewHandler,
                loggingConfigurationIdentifiers:
                  news.loggingConfigurationIdentifiers,
                tags: desiredTags,
              })
              .pipe(
                retryWhileThrottled,
                retryWhileHandlerPermissionPropagating,
              );
          }
          const arn = observed.arn;
          if (arn === undefined) {
            return yield* Effect.fail(
              new IvsChatRoomIncomplete({
                message: "IVS Chat CreateRoom returned no room ARN",
              }),
            );
          }

          // 3. Sync — every room setting is mutable via UpdateRoom; apply
          // only the drifted fields.
          const patch: Partial<ivschat.UpdateRoomRequest> = {};
          if (observed.name !== name) patch.name = name;
          if (
            news.maximumMessageRatePerSecond !== undefined &&
            observed.maximumMessageRatePerSecond !==
              news.maximumMessageRatePerSecond
          ) {
            patch.maximumMessageRatePerSecond =
              news.maximumMessageRatePerSecond;
          }
          if (
            news.maximumMessageLength !== undefined &&
            observed.maximumMessageLength !== news.maximumMessageLength
          ) {
            patch.maximumMessageLength = news.maximumMessageLength;
          }
          // Handler sync: `uri: ""` disassociates, and the API defaults
          // fallbackResult to ALLOW — compare normalized values so a
          // no-handler desire converges from either direction.
          const observedHandlerUri = observed.messageReviewHandler?.uri ?? "";
          const desiredHandlerUri = messageReviewHandler?.uri ?? "";
          const observedFallback =
            observed.messageReviewHandler?.fallbackResult ?? "ALLOW";
          const desiredFallback =
            messageReviewHandler?.fallbackResult ?? "ALLOW";
          if (
            observedHandlerUri !== desiredHandlerUri ||
            (desiredHandlerUri !== "" && observedFallback !== desiredFallback)
          ) {
            patch.messageReviewHandler = messageReviewHandler ?? { uri: "" };
          }
          if (
            news.loggingConfigurationIdentifiers !== undefined &&
            JSON.stringify(observed.loggingConfigurationIdentifiers ?? []) !==
              JSON.stringify(news.loggingConfigurationIdentifiers)
          ) {
            patch.loggingConfigurationIdentifiers =
              news.loggingConfigurationIdentifiers;
          }
          if (Object.keys(patch).length > 0) {
            yield* ivschat
              .updateRoom({ identifier: arn, ...patch })
              .pipe(
                retryWhileThrottled,
                retryWhileHandlerPermissionPropagating,
              );
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncIvsChatTags(arn, desiredTags);

          // 4. Return fresh attributes.
          const final = yield* getByIdentifier(arn);
          if (final === undefined) {
            return yield* Effect.fail(
              new IvsChatRoomIncomplete({
                message: `IVS Chat room '${arn}' vanished during reconcile`,
              }),
            );
          }
          yield* session.note(arn);
          return yield* toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* ivschat.deleteRoom({ identifier: output.roomArn }).pipe(
            retryWhileThrottled,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),

        list: () =>
          ivschat.listRooms.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.rooms),
            ),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  toAttrs(summary).pipe(
                    // Tolerate a malformed/deleted summary — drop it.
                    Effect.catchTag("IvsChatRoomIncomplete", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
                { concurrency: 5 },
              ),
            ),
            Effect.map((items) => items.filter((item) => item !== undefined)),
          ),
      };
    }),
  );
