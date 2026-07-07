import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import type { FcmCredentials } from "../Config.ts";
import type { ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";
import { fcmChannelIdForPhase } from "./pushNotificationDelivery.ts";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface FcmPushNotificationRequest {
  readonly token: string;
  readonly notification: ApnsNotificationPayload;
  readonly channelId: string;
}

export interface FcmDeliveryResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason?: string;
  readonly messageId: string | null;
}

export class FcmJwtEncodingError extends Schema.TaggedErrorClass<FcmJwtEncodingError>()(
  "FcmJwtEncodingError",
  {
    component: Schema.Literals(["header", "payload"]),
    clientEmail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode FCM JWT ${this.component} for ${this.clientEmail}.`;
  }
}

export class FcmJwtSigningError extends Schema.TaggedErrorClass<FcmJwtSigningError>()(
  "FcmJwtSigningError",
  {
    clientEmail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sign FCM JWT for ${this.clientEmail}.`;
  }
}

export class FcmHttpRequestError extends Schema.TaggedErrorClass<FcmHttpRequestError>()(
  "FcmHttpRequestError",
  {
    stage: Schema.Literals(["token", "send", "read-response"]),
    status: Schema.NullOr(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `FCM HTTP request failed during ${this.stage}.`;
  }
}

export const FcmError = Schema.Union([
  FcmJwtEncodingError,
  FcmJwtSigningError,
  FcmHttpRequestError,
]);
export type FcmError = typeof FcmError.Type;

const decodeFcmErrorResponseJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.optional(
        Schema.Struct({
          status: Schema.optional(Schema.String),
          message: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

const FcmOAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
});

const decodeFcmSendResponseJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.optional(Schema.String),
    }),
  ),
);

const encodeFcmJwtHeaderJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      alg: Schema.Literal("RS256"),
      typ: Schema.Literal("JWT"),
    }),
  ),
);

const encodeFcmJwtPayloadJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      iss: Schema.String,
      sub: Schema.String,
      aud: Schema.Literal(FCM_TOKEN_URL),
      iat: Schema.Number,
      exp: Schema.Number,
      scope: Schema.Literal(FCM_SCOPE),
    }),
  ),
);

const makeFcmJwtAssertion = Effect.fn("relay.fcm.make_jwt_assertion")(function* (input: {
  readonly credentials: FcmCredentials;
  readonly issuedAtUnixSeconds: number;
}) {
  const headerJson = yield* encodeFcmJwtHeaderJson({ alg: "RS256", typ: "JWT" }).pipe(
    Effect.mapError(
      (cause) =>
        new FcmJwtEncodingError({
          component: "header",
          clientEmail: input.credentials.clientEmail,
          cause,
        }),
    ),
  );
  const payloadJson = yield* encodeFcmJwtPayloadJson({
    iss: input.credentials.clientEmail,
    sub: input.credentials.clientEmail,
    aud: FCM_TOKEN_URL,
    iat: input.issuedAtUnixSeconds,
    exp: input.issuedAtUnixSeconds + 3600,
    scope: FCM_SCOPE,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new FcmJwtEncodingError({
          component: "payload",
          clientEmail: input.credentials.clientEmail,
          cause,
        }),
    ),
  );

  const privateKey = Redacted.value(input.credentials.privateKey).replace(/\\n/g, "\n");
  const header = Encoding.encodeBase64Url(headerJson);
  const payload = Encoding.encodeBase64Url(payloadJson);
  const signingInput = `${header}.${payload}`;

  return yield* Effect.try({
    try: () => {
      const signature = NodeCrypto.createSign("RSA-SHA256").update(signingInput).sign(privateKey);
      return `${signingInput}.${Encoding.encodeBase64Url(signature)}`;
    },
    catch: (cause) =>
      new FcmJwtSigningError({
        clientEmail: input.credentials.clientEmail,
        cause,
      }),
  });
});

function fcmReasonFromBody(body: string): string | undefined {
  if (body.trim().length === 0) {
    return undefined;
  }
  return Option.match(decodeFcmErrorResponseJson(body), {
    onNone: () => body,
    onSome: (parsed) => parsed.error?.status ?? parsed.error?.message ?? body,
  });
}

function makePushNotificationRequest(input: {
  readonly token: string;
  readonly notification: ApnsNotificationPayload;
  readonly channelId: string;
}): FcmPushNotificationRequest {
  return {
    token: input.token,
    notification: input.notification,
    channelId: input.channelId,
  };
}

function makeFcmMessageBody(request: FcmPushNotificationRequest): unknown {
  return {
    message: {
      token: request.token,
      notification: {
        title: request.notification.title,
        body: request.notification.body,
      },
      data: {
        environmentId: request.notification.environmentId,
        threadId: request.notification.threadId,
        deepLink: request.notification.deepLink,
      },
      android: {
        priority: "HIGH",
        notification: {
          channel_id: request.channelId,
        },
      },
    },
  };
}

export function fcmChannelIdForNotification(
  notification: ApnsNotificationPayload,
  aggregatePhase?: string,
): string {
  if (
    aggregatePhase === "waiting_for_approval" ||
    aggregatePhase === "waiting_for_input" ||
    aggregatePhase === "failed" ||
    aggregatePhase === "completed" ||
    aggregatePhase === "running" ||
    aggregatePhase === "starting" ||
    aggregatePhase === "stale"
  ) {
    return fcmChannelIdForPhase(aggregatePhase);
  }
  return "agent_running";
}

export class FcmClient extends Context.Service<
  FcmClient,
  {
    readonly makePushNotificationRequest: typeof makePushNotificationRequest;
    readonly sendPushNotificationRequest: (input: {
      readonly credentials: FcmCredentials;
      readonly request: FcmPushNotificationRequest;
      readonly issuedAtUnixSeconds: number;
    }) => Effect.Effect<FcmDeliveryResult, FcmError>;
  }
>()("t3code-relay/agentActivity/FcmClient") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const sendPushNotificationRequest: FcmClient["Service"]["sendPushNotificationRequest"] =
    Effect.fn("relay.fcm.send_push_notification_request")(function* (input) {
      const assertion = yield* makeFcmJwtAssertion({
        credentials: input.credentials,
        issuedAtUnixSeconds: input.issuedAtUnixSeconds,
      });
      const tokenResponse = yield* HttpClientRequest.post(FCM_TOKEN_URL).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
        httpClient.execute,
        Effect.mapError(
          (cause) =>
            new FcmHttpRequestError({
              stage: "token",
              status: null,
              cause,
            }),
        ),
      );
      if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
        const tokenBody = yield* tokenResponse.text.pipe(
          Effect.mapError(
            (cause) =>
              new FcmHttpRequestError({
                stage: "read-response",
                status: tokenResponse.status,
                cause,
              }),
          ),
        );
        return yield* new FcmHttpRequestError({
          stage: "token",
          status: tokenResponse.status,
          cause: new Error(tokenBody),
        });
      }
      const tokenPayload = yield* HttpClientResponse.schemaBodyJson(FcmOAuthTokenResponse)(
        tokenResponse,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new FcmHttpRequestError({
              stage: "read-response",
              status: tokenResponse.status,
              cause,
            }),
        ),
      );

      const url = `https://fcm.googleapis.com/v1/projects/${input.credentials.projectId}/messages:send`;
      const response = yield* HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${tokenPayload.access_token}`,
          "content-type": "application/json; charset=UTF-8",
        }),
        HttpClientRequest.bodyJson(makeFcmMessageBody(input.request)),
        Effect.flatMap(httpClient.execute),
        Effect.mapError(
          (cause) =>
            new FcmHttpRequestError({
              stage: "send",
              status: null,
              cause,
            }),
        ),
      );

      const body = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new FcmHttpRequestError({
              stage: "read-response",
              status: response.status,
              cause,
            }),
        ),
      );

      if (response.status >= 200 && response.status < 300) {
        const parsed = decodeFcmSendResponseJson(body);
        return {
          ok: true,
          status: response.status,
          messageId: Option.match(parsed, {
            onNone: () => null,
            onSome: (value) => value.name ?? null,
          }),
        };
      }

      const reason = fcmReasonFromBody(body);
      return {
        ok: false,
        status: response.status,
        ...(reason === undefined ? {} : { reason }),
        messageId: null,
      };
    });

  return FcmClient.of({
    makePushNotificationRequest,
    sendPushNotificationRequest,
  });
});

export const layer = Layer.effect(FcmClient, make);
