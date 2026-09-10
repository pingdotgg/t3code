import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { readDiscordBotToken } from "./config.ts";
import type { DiscordEmbed } from "./render.ts";

export const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Discord rate limit buckets are per-route. We key on the route template
 * (channel id included, since limits are per-channel) rather than the full URL.
 */
const bucketKey = (method: string, route: string): string => `${method} ${route}`;

export class DiscordRequestError extends Schema.TaggedError<DiscordRequestError>()(
  "DiscordRequestError",
  {
    route: Schema.String,
    method: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Discord request failed: ${this.method} ${this.route}`;
  }
}

export class DiscordResponseError extends Schema.TaggedError<DiscordResponseError>()(
  "DiscordResponseError",
  {
    route: Schema.String,
    method: Schema.String,
    status: Schema.Number,
    /** Discord's own error code, e.g. 10003 unknown channel. */
    discordCode: Schema.optional(Schema.Number),
    body: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Discord responded ${this.status} to ${this.method} ${this.route}`;
  }
}

export type DiscordRestError = DiscordRequestError | DiscordResponseError;

/** 404 / 10003 / 10008: the channel, thread, or message is gone for good. */
export const isGoneError = (error: DiscordRestError): boolean =>
  error._tag === "DiscordResponseError" &&
  (error.status === 404 || error.discordCode === 10003 || error.discordCode === 10008);

/** 50083 / 40058: the thread is archived and must be unarchived before writing. */
export const isArchivedError = (error: DiscordRestError): boolean =>
  error._tag === "DiscordResponseError" &&
  (error.discordCode === 50083 || error.discordCode === 40058);

/** 401 / 403: bad token or missing permission. Stop hammering. */
export const isAuthError = (error: DiscordRestError): boolean =>
  error._tag === "DiscordResponseError" && (error.status === 401 || error.status === 403);

export interface DiscordMessage {
  readonly id: string;
  readonly channel_id: string;
  readonly content: string;
  readonly author: { readonly id: string; readonly bot?: boolean; readonly username?: string };
  readonly webhook_id?: string;
  readonly attachments?: ReadonlyArray<unknown>;
}

export interface CreateMessageInput {
  readonly channelId: string;
  readonly content?: string;
  readonly embeds?: ReadonlyArray<DiscordEmbed>;
}

export interface EditMessageInput {
  readonly channelId: string;
  readonly messageId: string;
  readonly content?: string;
  readonly embeds?: ReadonlyArray<DiscordEmbed>;
}

export interface StartThreadInput {
  readonly channelId: string;
  readonly messageId: string;
  readonly name: string;
  /** Minutes. 10080 = 7 days, which makes auto-archive rare. */
  readonly autoArchiveDuration?: number;
}

export interface ListMessagesInput {
  readonly channelId: string;
  readonly afterMessageId: string | null;
  readonly limit?: number;
}

interface BucketState {
  /** Epoch millis before which this bucket must not be used. */
  readonly notBefore: number;
}

/**
 * Discord's error/rate-limit envelope. Parsed with a schema rather than
 * JSON.parse so a malformed body degrades to defaults instead of throwing.
 */
const DiscordErrorBody = Schema.Struct({
  code: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
  retry_after: Schema.optional(Schema.Number),
  global: Schema.optional(Schema.Boolean),
});

const decodeErrorBody = Schema.decodeUnknownEffect(Schema.fromJsonString(DiscordErrorBody));

const readErrorBody = (text: string) =>
  decodeErrorBody(text).pipe(Effect.orElseSucceed(() => ({}) as typeof DiscordErrorBody.Type));

export class DiscordRestClient extends Context.Service<
  DiscordRestClient,
  {
    readonly createMessage: (
      input: CreateMessageInput,
    ) => Effect.Effect<DiscordMessage, DiscordRestError>;
    readonly editMessage: (
      input: EditMessageInput,
    ) => Effect.Effect<DiscordMessage, DiscordRestError>;
    readonly startThreadFromMessage: (
      input: StartThreadInput,
    ) => Effect.Effect<{ readonly id: string }, DiscordRestError>;
    readonly listMessagesAfter: (
      input: ListMessagesInput,
    ) => Effect.Effect<ReadonlyArray<DiscordMessage>, DiscordRestError>;
    readonly modifyThread: (input: {
      readonly threadId: string;
      readonly name?: string;
      readonly archived?: boolean;
    }) => Effect.Effect<void, DiscordRestError>;
    readonly createReaction: (input: {
      readonly channelId: string;
      readonly messageId: string;
      readonly emoji: string;
    }) => Effect.Effect<void, DiscordRestError>;
  }
>()("t3/discord/DiscordRestClient") {}

export const make = (
  options: { readonly token: string } | { readonly tokenRef: Ref.Ref<string> },
) =>
  Effect.gen(function* () {
    const tokenRef = "tokenRef" in options ? options.tokenRef : yield* Ref.make(options.token);
    const buckets = yield* Ref.make(new Map<string, BucketState>());
    const globalGate = yield* Ref.make<BucketState>({ notBefore: 0 });

    const baseClient = yield* HttpClient.HttpClient;
    // Retry only transport-level faults. 429 is handled explicitly below,
    // because retrying it without honouring `retry_after` is how a bot gets
    // banned — and that would take the Hermes gateway down with it.
    const httpClient = baseClient.pipe(
      HttpClient.retryTransient({ retryOn: "errors-only", times: 3 }),
    );

    const waitForBucket = (key: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const globalState = yield* Ref.get(globalGate);
        const bucketMap = yield* Ref.get(buckets);
        const bucketState = bucketMap.get(key);
        const notBefore = Math.max(globalState.notBefore, bucketState?.notBefore ?? 0);
        if (notBefore > now) {
          yield* Effect.sleep(Duration.millis(notBefore - now));
        }
      });

    const recordRetryAfter = (key: string, retryAfterSeconds: number, isGlobal: boolean) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const notBefore = now + Math.ceil(retryAfterSeconds * 1000);
        if (isGlobal) {
          yield* Ref.set(globalGate, { notBefore });
          return;
        }
        yield* Ref.update(buckets, (map) => {
          const next = new Map(map);
          next.set(key, { notBefore });
          return next;
        });
      });

    const request = <A>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      route: string,
      body?: unknown,
      attempt = 0,
    ): Effect.Effect<A, DiscordRestError> =>
      Effect.gen(function* () {
        const key = bucketKey(method, route);
        yield* waitForBucket(key);

        const url = `${DISCORD_API_BASE}${route}`;
        const token = yield* Ref.get(tokenRef);
        let req = HttpClientRequest.make(method)(url).pipe(
          HttpClientRequest.setHeaders({
            Authorization: `Bot ${token}`,
            "User-Agent": "T3CodeDiscordBridge (https://t3.chat, 1.0)",
          }),
        );
        if (body !== undefined) {
          req = yield* HttpClientRequest.bodyJson(body)(req).pipe(
            Effect.mapError((cause) => new DiscordRequestError({ route, method, cause })),
          );
        }

        const response = yield* httpClient
          .execute(req)
          .pipe(Effect.mapError((cause) => new DiscordRequestError({ route, method, cause })));

        if (response.status === 429) {
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => "{}"));
          const parsed = yield* readErrorBody(text);
          const retryAfter = parsed.retry_after ?? 1;
          const isGlobal = parsed.global === true;
          yield* Effect.logWarning("discord rate limited", {
            route,
            retryAfter,
            global: isGlobal,
          });
          yield* recordRetryAfter(key, retryAfter, isGlobal);
          if (attempt >= 3) {
            return yield* new DiscordResponseError({ route, method, status: 429, body: text });
          }
          return yield* request<A>(method, route, body, attempt + 1);
        }

        if (response.status < 200 || response.status >= 300) {
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          const parsed = yield* readErrorBody(text);
          return yield* new DiscordResponseError({
            route,
            method,
            status: response.status,
            ...(parsed.code === undefined ? {} : { discordCode: parsed.code }),
            body: text.slice(0, 500),
          });
        }

        if (response.status === 204) {
          return undefined as A;
        }

        return yield* response.json.pipe(
          Effect.map((value) => value as A),
          Effect.mapError((cause) => new DiscordRequestError({ route, method, cause })),
        );
      });

    return {
      createMessage: (input) =>
        request<DiscordMessage>("POST", `/channels/${input.channelId}/messages`, {
          ...(input.content === undefined ? {} : { content: input.content }),
          ...(input.embeds === undefined ? {} : { embeds: input.embeds }),
          // Never let mirrored repo content ping anyone.
          allowed_mentions: { parse: [] },
        }),

      editMessage: (input) =>
        request<DiscordMessage>(
          "PATCH",
          `/channels/${input.channelId}/messages/${input.messageId}`,
          {
            ...(input.content === undefined ? {} : { content: input.content }),
            ...(input.embeds === undefined ? {} : { embeds: input.embeds }),
            allowed_mentions: { parse: [] },
          },
        ),

      startThreadFromMessage: (input) =>
        request<{ id: string }>(
          "POST",
          `/channels/${input.channelId}/messages/${input.messageId}/threads`,
          {
            name: input.name,
            auto_archive_duration: input.autoArchiveDuration ?? 10080,
          },
        ),

      listMessagesAfter: (input) => {
        const params = new URLSearchParams({ limit: String(input.limit ?? 25) });
        if (input.afterMessageId !== null) {
          params.set("after", input.afterMessageId);
        }
        return request<ReadonlyArray<DiscordMessage>>(
          "GET",
          `/channels/${input.channelId}/messages?${params.toString()}`,
        );
      },

      modifyThread: (input) =>
        request<unknown>("PATCH", `/channels/${input.threadId}`, {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.archived === undefined ? {} : { archived: input.archived }),
        }).pipe(Effect.asVoid),

      createReaction: (input) =>
        request<unknown>(
          "PUT",
          `/channels/${input.channelId}/messages/${input.messageId}/reactions/${encodeURIComponent(
            input.emoji,
          )}/@me`,
        ).pipe(Effect.asVoid),
    } satisfies DiscordRestClient["Service"];
  });

export const layer = (options: { readonly token: string }) =>
  Layer.effect(DiscordRestClient, make(options)).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * Live layer that resolves the bot token from the secret store at build time.
 *
 * An empty token is not an error here — the bridge checks for one in `start()`
 * and stays dormant, so a server with no Discord configured behaves exactly as
 * it did before this feature existed.
 */
export const layerLive = Layer.effect(
  DiscordRestClient,
  Effect.gen(function* () {
    const token = yield* readDiscordBotToken;
    return yield* make({ token });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
