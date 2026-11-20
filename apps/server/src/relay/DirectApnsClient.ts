// @effect-diagnostics nodeBuiltinImport:off -- APNs requires HTTP/2, which Effect's HttpClient and Node's fetch do not guarantee.
import * as NodeHttp2 from "node:http2";

import { makeApnsProviderTokenCache } from "@t3tools/shared/apnsProviderToken";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { DirectApnsNotification, DirectLiveActivityContent } from "./directApnsPolicy.ts";
import type { StoredPushDevice } from "./DirectApnsDevices.ts";

const APNS_PRODUCTION_ORIGIN = "https://api.push.apple.com";
const APNS_SANDBOX_ORIGIN = "https://api.sandbox.push.apple.com";
const APNS_REQUEST_TIMEOUT = "10 seconds";

// Credentials come from the environment, with the secret store as an
// alternative for servers that cannot set env vars.
const KEY_ID_ENV = "T3CODE_APNS_KEY_ID";
const TEAM_ID_ENV = "T3CODE_APNS_TEAM_ID";
const PRIVATE_KEY_PATH_ENV = "T3CODE_APNS_PRIVATE_KEY_PATH";
const KEY_ID_SECRET = "apns-key-id";
const TEAM_ID_SECRET = "apns-team-id";
const PRIVATE_KEY_SECRET = "apns-private-key";

const PERMANENT_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

export interface ApnsHttp2Request {
  readonly origin: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ApnsHttp2Response {
  readonly status: number;
  readonly body: string;
}

export class DirectApnsTransportError extends Schema.TaggedError<DirectApnsTransportError>()(
  "DirectApnsTransportError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "APNs request failed.";
  }
}

export class DirectApnsTransport extends Context.Service<
  DirectApnsTransport,
  {
    readonly post: (
      request: ApnsHttp2Request,
    ) => Effect.Effect<ApnsHttp2Response, DirectApnsTransportError>;
  }
>()("t3/relay/DirectApnsClient/DirectApnsTransport") {}

export type DirectApnsSendResult =
  | { readonly outcome: "sent" }
  | { readonly outcome: "unconfigured" }
  | {
      readonly outcome: "rejected";
      readonly status: number;
      readonly reason: string | undefined;
      /** The token is permanently dead and must not be tried again. */
      readonly removeToken: boolean;
    }
  | { readonly outcome: "error"; readonly removeToken: false };

export type LiveActivityEvent = "start" | "update" | "end";

// Seconds, matching the relay's STALE_AFTER_SECONDS: a card whose pushes stop
// degrades to "out of date" instead of looking alive forever.
const LIVE_ACTIVITY_STALE_AFTER_SECONDS = 10 * 60;
const LIVE_ACTIVITY_DISMISS_AFTER_SECONDS = 2 * 60;

export class DirectApnsClient extends Context.Service<
  DirectApnsClient,
  {
    readonly isConfigured: Effect.Effect<boolean>;
    readonly send: (input: {
      readonly device: StoredPushDevice;
      readonly notification: DirectApnsNotification;
    }) => Effect.Effect<DirectApnsSendResult>;
    readonly sendLiveActivity: (input: {
      readonly target: {
        readonly apsEnvironment: StoredPushDevice["apsEnvironment"];
        readonly bundleId: string;
        readonly deviceId: string;
      };
      readonly token: string;
      readonly event: LiveActivityEvent;
      readonly content: DirectLiveActivityContent;
      readonly alert?: { readonly title: string; readonly body: string };
    }) => Effect.Effect<DirectApnsSendResult>;
  }
>()("t3/relay/DirectApnsClient") {}

const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ reason: Schema.optional(Schema.String) })),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const reasonFromBody = (body: string): string | undefined =>
  Option.getOrUndefined(decodeErrorBody(body))?.reason;

export const makeNodeHttp2Transport = Effect.gen(function* () {
  const sessions = new Map<string, NodeHttp2.ClientHttp2Session>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    }),
  );

  // One long-lived session per APNs host: Apple asks providers to keep
  // connections open rather than reconnecting for every push.
  const sessionFor = (origin: string) => {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = NodeHttp2.connect(origin);
    session.unref();
    const forget = () => {
      if (sessions.get(origin) === session) sessions.delete(origin);
    };
    // Request-level errors reach the caller through the stream; this only
    // keeps a dead session from being reused.
    session.on("error", forget);
    session.on("close", forget);
    session.on("goaway", () => {
      forget();
      session.close();
    });
    sessions.set(origin, session);
    return session;
  };

  return DirectApnsTransport.of({
    post: (request) =>
      Effect.tryPromise({
        try: (signal) =>
          new Promise<ApnsHttp2Response>((resolve, reject) => {
            const stream = sessionFor(request.origin).request({
              ":method": "POST",
              ":path": request.path,
              ...request.headers,
            });
            const chunks: Buffer[] = [];
            let status = 0;
            signal.addEventListener("abort", () =>
              stream.close(NodeHttp2.constants.NGHTTP2_CANCEL),
            );
            stream.on("response", (headers) => {
              status = Number(headers[":status"] ?? 0);
            });
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () =>
              resolve({ status, body: Buffer.concat(chunks).toString("utf8") }),
            );
            stream.on("error", reject);
            stream.end(request.body);
          }),
        catch: (cause) => new DirectApnsTransportError({ cause }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: APNS_REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(new DirectApnsTransportError({ cause: "APNs request timed out" })),
        }),
      ),
  });
});

export const transportLayer = Layer.effect(DirectApnsTransport, makeNodeHttp2Transport);

const make = Effect.gen(function* () {
  const transport = yield* DirectApnsTransport;
  const fileSystem = yield* FileSystem.FileSystem;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const configProvider = yield* ConfigProvider.ConfigProvider;
  const providerTokens = makeApnsProviderTokenCache();

  const readSecret = (name: string) =>
    secrets.get(name).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const readConfig = (name: string) =>
    Config.String(name).pipe(
      Config.option,
      // The send path runs outside the layer's context, so pin the provider it was built with.
      Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
      Effect.map(Option.filter((value) => value.trim().length > 0)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const readPrivateKey = Effect.gen(function* () {
    const path = yield* readConfig(PRIVATE_KEY_PATH_ENV);
    if (Option.isNone(path)) return yield* readSecret(PRIVATE_KEY_SECRET);
    // An unreadable key file is a misconfiguration, never a reason to fail a thread.
    return yield* fileSystem.readFileString(path.value).pipe(
      Effect.map(Option.some),
      Effect.tapError(() =>
        Effect.logWarning("direct APNs key file could not be read", {
          envVar: PRIVATE_KEY_PATH_ENV,
        }),
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  });

  const readCredentials = Effect.gen(function* () {
    const keyId = Option.orElse(yield* readConfig(KEY_ID_ENV), () => Option.none<string>());
    const teamId = yield* readConfig(TEAM_ID_ENV);
    const privateKey = yield* readPrivateKey;
    return Option.all({
      keyId: Option.isSome(keyId) ? keyId : yield* readSecret(KEY_ID_SECRET),
      teamId: Option.isSome(teamId) ? teamId : yield* readSecret(TEAM_ID_SECRET),
      privateKey,
    });
  });

  const deliver = Effect.fnUntraced(function* (input: {
    readonly target: {
      readonly apsEnvironment: StoredPushDevice["apsEnvironment"];
      readonly deviceId: string;
    };
    readonly token: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
    readonly nowSeconds: number;
  }): Effect.fn.Return<DirectApnsSendResult, never, never> {
    const { target } = input;
    const credentials = yield* readCredentials;
    if (Option.isNone(credentials)) {
      yield* Effect.logDebug("direct APNs push skipped; credentials not configured");
      return { outcome: "unconfigured" } as const;
    }
    const jwt = yield* Effect.try(() =>
      providerTokens.getJwt(credentials.value, input.nowSeconds),
    ).pipe(Effect.option);
    if (Option.isNone(jwt)) {
      yield* Effect.logWarning("direct APNs provider token could not be signed; check the .p8 key");
      return { outcome: "error", removeToken: false } as const;
    }
    const response = yield* transport
      .post({
        // The token's own environment decides the host: a dev build and a
        // store build can both be registered with one server.
        origin:
          target.apsEnvironment === "production" ? APNS_PRODUCTION_ORIGIN : APNS_SANDBOX_ORIGIN,
        path: `/3/device/${input.token}`,
        headers: {
          authorization: `bearer ${jwt.value}`,
          "content-type": "application/json",
          ...input.headers,
        },
        body: encodeJson(input.body),
      })
      .pipe(Effect.option);
    if (Option.isNone(response)) {
      yield* Effect.logWarning("direct APNs push failed in transport", {
        deviceId: target.deviceId,
      });
      return { outcome: "error", removeToken: false } as const;
    }
    const { status, body } = response.value;
    if (status >= 200 && status < 300) return { outcome: "sent" } as const;
    const reason = reasonFromBody(body);
    yield* Effect.logWarning("direct APNs push rejected", {
      deviceId: target.deviceId,
      status,
      reason,
    });
    return {
      outcome: "rejected",
      status,
      reason,
      removeToken:
        status === 410 ||
        (status === 400 && reason !== undefined && PERMANENT_TOKEN_REASONS.has(reason)),
    } as const;
  });

  const send: DirectApnsClient["Service"]["send"] = Effect.fn("DirectApnsClient.send")(function* ({
    device,
    notification,
  }) {
    return yield* deliver({
      target: device,
      token: device.apnsToken,
      nowSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1_000),
      headers: {
        "apns-push-type": "alert",
        "apns-topic": device.bundleId,
        "apns-priority": "10",
      },
      body: {
        aps: {
          alert: { title: notification.title, body: notification.body },
          sound: "default",
          "thread-id":
            notification.threadId.length > 0
              ? `${notification.environmentId}/${notification.threadId}`
              : "t3-agent-alerts",
        },
        // Expo iOS exposes userInfo.body as notification.content.data.
        body: {
          environmentId: notification.environmentId,
          threadId: notification.threadId,
          deepLink: notification.deepLink,
          phase: notification.phase,
          updatedAt: notification.updatedAt,
        },
      },
    });
  });

  const sendLiveActivity: DirectApnsClient["Service"]["sendLiveActivity"] = Effect.fn(
    "DirectApnsClient.sendLiveActivity",
  )(function* ({ target, token, event, content, alert }) {
    const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    const urgent =
      event !== "update" ||
      alert !== undefined ||
      content.activities.some(
        (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
      );
    return yield* deliver({
      target,
      token,
      nowSeconds,
      headers: {
        "apns-push-type": "liveactivity",
        "apns-topic": `${target.bundleId}.push-type.liveactivity`,
        "apns-priority": urgent ? "10" : "5",
      },
      body: {
        aps: {
          timestamp: nowSeconds,
          event,
          // expo-widgets' ActivityKit ContentState: the widget name plus the
          // layout props as a JSON string, exactly what LiveActivity.update writes.
          "content-state": { name: "AgentActivity", props: encodeJson(content) },
          ...(event === "end"
            ? { "dismissal-date": nowSeconds + LIVE_ACTIVITY_DISMISS_AFTER_SECONDS }
            : { "stale-date": nowSeconds + LIVE_ACTIVITY_STALE_AFTER_SECONDS }),
          // iOS silently drops a push-to-start that carries no alert.
          ...(event === "start"
            ? {
                "attributes-type": "LiveActivityAttributes",
                attributes: {},
                // Without this iOS never issues an update token for a push-started card.
                "input-push-token": 1,
                alert: { title: content.title, body: content.subtitle },
              }
            : {}),
          // An alert on an update or end wakes the screen and expands the island,
          // like the relay's pushes, instead of redrawing silently.
          ...(event !== "start" && alert ? { alert: { ...alert, sound: "default" } } : {}),
        },
      },
    });
  });

  return DirectApnsClient.of({
    isConfigured: readCredentials.pipe(Effect.map(Option.isSome)),
    send,
    sendLiveActivity,
  });
});

export const layer = Layer.effect(DirectApnsClient, make);
