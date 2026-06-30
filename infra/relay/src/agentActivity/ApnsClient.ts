import * as NodeCrypto from "node:crypto";

import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { ApnsEnvironment as ApnsEnvironmentSchema, type ApnsCredentials } from "../Config.ts";
import type { ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";

const LIVE_ACTIVITY_NAME = "AgentActivity";
const STALE_AFTER_SECONDS = 2 * 60;
const DISMISS_AFTER_SECONDS = 5 * 60;

const ApnsLiveActivityEventSchema = Schema.Literals(["start", "update", "end"]);
export type ApnsLiveActivityEvent = typeof ApnsLiveActivityEventSchema.Type;

const ApnsRequestKindSchema = Schema.Literals(["live-activity", "push-notification"]);

interface ApnsLiveActivityRequest {
  readonly token: string;
  readonly event: ApnsLiveActivityEvent;
  readonly priority: "5" | "10";
  readonly payload: unknown;
}

interface ApnsPushNotificationRequest {
  readonly token: string;
  readonly priority: "10";
  readonly payload: unknown;
}

export interface ApnsDeliveryResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason?: string;
  readonly apnsId: string | null;
}

export class ApnsJwtEncodingError extends Schema.TaggedErrorClass<ApnsJwtEncodingError>()(
  "ApnsJwtEncodingError",
  {
    component: Schema.Literals(["header", "payload"]),
    teamId: Schema.String,
    keyId: Schema.String,
    issuedAtUnixSeconds: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode APNs JWT ${this.component} for key ${this.keyId}.`;
  }
}

export class ApnsJwtSigningError extends Schema.TaggedErrorClass<ApnsJwtSigningError>()(
  "ApnsJwtSigningError",
  {
    teamId: Schema.String,
    keyId: Schema.String,
    issuedAtUnixSeconds: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sign APNs JWT for key ${this.keyId}.`;
  }
}

export class ApnsHttpRequestError extends Schema.TaggedErrorClass<ApnsHttpRequestError>()(
  "ApnsHttpRequestError",
  {
    requestKind: ApnsRequestKindSchema,
    event: Schema.NullOr(ApnsLiveActivityEventSchema),
    environment: ApnsEnvironmentSchema,
    bundleId: Schema.String,
    tokenSuffix: Schema.String,
    stage: Schema.Literals(["send", "read-response"]),
    status: Schema.NullOr(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `APNs ${this.requestKind} request failed during ${this.stage} in ${this.environment}.`;
  }
}

export const ApnsError = Schema.Union([
  ApnsJwtEncodingError,
  ApnsJwtSigningError,
  ApnsHttpRequestError,
]);
export type ApnsError = typeof ApnsError.Type;

const decodeApnsErrorResponseJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      reason: Schema.optional(Schema.String),
    }),
  ),
);
const encodeApnsJwtHeaderJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      alg: Schema.Literal("ES256"),
      kid: Schema.String,
    }),
  ),
);
const encodeApnsJwtPayloadJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      iss: Schema.String,
      iat: Schema.Number,
    }),
  ),
);

const makeApnsJwt = Effect.fn("relay.apns.make_jwt")(function* (input: {
  readonly teamId: ApnsCredentials["teamId"];
  readonly keyId: ApnsCredentials["keyId"];
  readonly privateKey: ApnsCredentials["privateKey"];
  readonly issuedAtUnixSeconds: number;
}) {
  const headerJson = yield* encodeApnsJwtHeaderJson({ alg: "ES256", kid: input.keyId }).pipe(
    Effect.mapError(
      (cause) =>
        new ApnsJwtEncodingError({
          component: "header",
          teamId: input.teamId,
          keyId: input.keyId,
          issuedAtUnixSeconds: input.issuedAtUnixSeconds,
          cause,
        }),
    ),
  );
  const payloadJson = yield* encodeApnsJwtPayloadJson({
    iss: input.teamId,
    iat: input.issuedAtUnixSeconds,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ApnsJwtEncodingError({
          component: "payload",
          teamId: input.teamId,
          keyId: input.keyId,
          issuedAtUnixSeconds: input.issuedAtUnixSeconds,
          cause,
        }),
    ),
  );

  const privateKey = Redacted.value(input.privateKey);
  const header = Encoding.encodeBase64Url(headerJson);
  const payload = Encoding.encodeBase64Url(payloadJson);
  const signingInput = `${header}.${payload}`;

  return yield* Effect.try({
    try: () => {
      const signature = NodeCrypto.createSign("sha256")
        .update(signingInput)
        .sign({
          key: privateKey.replace(/\\n/g, "\n"),
          dsaEncoding: "ieee-p1363",
        });
      return `${signingInput}.${Encoding.encodeBase64Url(signature)}`;
    },
    catch: (cause) =>
      new ApnsJwtSigningError({
        teamId: input.teamId,
        keyId: input.keyId,
        issuedAtUnixSeconds: input.issuedAtUnixSeconds,
        cause,
      }),
  });
});

function contentState(state: RelayAgentActivityAggregateState) {
  return {
    name: LIVE_ACTIVITY_NAME,
    props: JSON.stringify(state),
  };
}

interface LiveActivityRequestBase {
  readonly token: string;
  readonly nowEpochSeconds: number;
  readonly nowIso: string;
}

type MakeLiveActivityRequestInput =
  | (LiveActivityRequestBase & {
      readonly event: "end";
      readonly state: RelayAgentActivityAggregateState | null;
    })
  | (LiveActivityRequestBase & {
      readonly event: "start" | "update";
      readonly state: RelayAgentActivityAggregateState;
    });

function makeLiveActivityRequest(input: MakeLiveActivityRequestInput): ApnsLiveActivityRequest {
  const timestamp = input.nowEpochSeconds;
  if (input.event === "end") {
    return {
      token: input.token,
      event: input.event,
      priority: "10",
      payload: {
        aps: {
          timestamp,
          event: "end",
          ...(input.state ? { "content-state": contentState(input.state) } : {}),
          "dismissal-date": timestamp + DISMISS_AFTER_SECONDS,
        },
      },
    };
  }

  const state = input.state;
  return {
    token: input.token,
    event: input.event,
    priority: input.event === "update" ? "5" : "10",
    payload: {
      aps: {
        timestamp,
        event: input.event,
        ...(input.event === "start"
          ? {
              "attributes-type": "LiveActivityAttributes",
              attributes: {},
              "input-push-token": 1,
              alert: {
                title: state.title,
                body: state.subtitle,
              },
            }
          : {}),
        "content-state": contentState(state),
        "stale-date": timestamp + STALE_AFTER_SECONDS,
      },
    },
  };
}

function makePushNotificationRequest(input: {
  readonly token: string;
  readonly notification: ApnsNotificationPayload;
}): ApnsPushNotificationRequest {
  return {
    token: input.token,
    priority: "10",
    payload: {
      aps: {
        alert: {
          title: input.notification.title,
          body: input.notification.body,
        },
        sound: "default",
      },
      environmentId: input.notification.environmentId,
      ...(input.notification.threadId !== undefined
        ? { threadId: input.notification.threadId }
        : {}),
      ...(input.notification.boardId !== undefined ? { boardId: input.notification.boardId } : {}),
      ...(input.notification.ticketId !== undefined
        ? { ticketId: input.notification.ticketId }
        : {}),
      deepLink: input.notification.deepLink,
    },
  };
}

function apnsReasonFromBody(body: string): string | undefined {
  if (body.trim().length === 0) {
    return undefined;
  }
  return Option.match(decodeApnsErrorResponseJson(body), {
    onNone: () => body,
    onSome: (parsed) => parsed.reason ?? body,
  });
}

export class ApnsClient extends Context.Service<
  ApnsClient,
  {
    readonly makeLiveActivityRequest: typeof makeLiveActivityRequest;
    readonly makePushNotificationRequest: typeof makePushNotificationRequest;
    readonly sendLiveActivityRequest: (input: {
      readonly credentials: ApnsCredentials;
      readonly request: ApnsLiveActivityRequest;
      readonly issuedAtUnixSeconds: number;
    }) => Effect.Effect<ApnsDeliveryResult, ApnsError>;
    readonly sendPushNotificationRequest: (input: {
      readonly credentials: ApnsCredentials;
      readonly request: ApnsPushNotificationRequest;
      readonly issuedAtUnixSeconds: number;
    }) => Effect.Effect<ApnsDeliveryResult, ApnsError>;
  }
>()("t3code-relay/agentActivity/ApnsClient") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const sendLiveActivityRequest: ApnsClient["Service"]["sendLiveActivityRequest"] = Effect.fn(
    "relay.apns.send_live_activity_request",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({ "relay.apns.event": input.request.event });
    const jwt = yield* makeApnsJwt({
      ...input.credentials,
      issuedAtUnixSeconds: input.issuedAtUnixSeconds,
    });
    const host =
      input.credentials.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
    const response = yield* HttpClientRequest.post(`${host}/3/device/${input.request.token}`).pipe(
      HttpClientRequest.setHeaders({
        authorization: `bearer ${jwt}`,
        "apns-priority": input.request.priority,
        "apns-push-type": "liveactivity",
        "apns-topic": `${input.credentials.bundleId}.push-type.liveactivity`,
      }),
      HttpClientRequest.bodyJson(input.request.payload),
      Effect.flatMap(httpClient.execute),
      Effect.mapError(
        (cause) =>
          new ApnsHttpRequestError({
            requestKind: "live-activity",
            event: input.request.event,
            environment: input.credentials.environment,
            bundleId: input.credentials.bundleId,
            tokenSuffix: input.request.token.slice(-8),
            stage: "send",
            status: null,
            cause,
          }),
      ),
    );
    const responseText = yield* response.text.pipe(
      Effect.mapError(
        (cause) =>
          new ApnsHttpRequestError({
            requestKind: "live-activity",
            event: input.request.event,
            environment: input.credentials.environment,
            bundleId: input.credentials.bundleId,
            tokenSuffix: input.request.token.slice(-8),
            stage: "read-response",
            status: response.status,
            cause,
          }),
      ),
    );
    const reason = apnsReasonFromBody(responseText);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      ...(reason === undefined ? {} : { reason }),
      apnsId: Option.getOrNull(Headers.get(response.headers, "apns-id")),
    };
  });

  const sendPushNotificationRequest: ApnsClient["Service"]["sendPushNotificationRequest"] =
    Effect.fn("relay.apns.send_push_notification_request")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.apns.event": "push_notification" });
      const jwt = yield* makeApnsJwt({
        ...input.credentials,
        issuedAtUnixSeconds: input.issuedAtUnixSeconds,
      });
      const host =
        input.credentials.environment === "production"
          ? "https://api.push.apple.com"
          : "https://api.sandbox.push.apple.com";
      const response = yield* HttpClientRequest.post(
        `${host}/3/device/${input.request.token}`,
      ).pipe(
        HttpClientRequest.setHeaders({
          authorization: `bearer ${jwt}`,
          "apns-priority": input.request.priority,
          "apns-push-type": "alert",
          "apns-topic": input.credentials.bundleId,
        }),
        HttpClientRequest.bodyJson(input.request.payload),
        Effect.flatMap(httpClient.execute),
        Effect.mapError(
          (cause) =>
            new ApnsHttpRequestError({
              requestKind: "push-notification",
              event: null,
              environment: input.credentials.environment,
              bundleId: input.credentials.bundleId,
              tokenSuffix: input.request.token.slice(-8),
              stage: "send",
              status: null,
              cause,
            }),
        ),
      );
      const responseText = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new ApnsHttpRequestError({
              requestKind: "push-notification",
              event: null,
              environment: input.credentials.environment,
              bundleId: input.credentials.bundleId,
              tokenSuffix: input.request.token.slice(-8),
              stage: "read-response",
              status: response.status,
              cause,
            }),
        ),
      );
      const reason = apnsReasonFromBody(responseText);
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        ...(reason === undefined ? {} : { reason }),
        apnsId: Option.getOrNull(Headers.get(response.headers, "apns-id")),
      };
    });

  return ApnsClient.of({
    makeLiveActivityRequest,
    makePushNotificationRequest,
    sendLiveActivityRequest,
    sendPushNotificationRequest,
  });
});

export const layer = Layer.effect(ApnsClient, make);
