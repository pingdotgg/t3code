import * as NodeCrypto from "node:crypto";

import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpBody,
  type HttpClientError,
} from "effect/unstable/http";
import type { ApnsCredentials } from "./settings.ts";
import type { ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";

const LIVE_ACTIVITY_NAME = "AgentActivity";
const STALE_AFTER_SECONDS = 2 * 60;
const DISMISS_AFTER_SECONDS = 5 * 60;

export type ApnsLiveActivityEvent = "start" | "update" | "end";

export interface ApnsLiveActivityRequest {
  readonly token: string;
  readonly event: ApnsLiveActivityEvent;
  readonly priority: "5" | "10";
  readonly payload: unknown;
}

export interface ApnsPushNotificationRequest {
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

export class ApnsSigningError extends Data.TaggedError("ApnsSigningError")<{
  readonly cause: unknown;
}> {}

export class ApnsHttpRequestError extends Data.TaggedError("ApnsHttpRequestError")<{
  readonly cause: HttpClientError.HttpClientError | HttpBody.HttpBodyError;
}> {}

export class ApnsInvalidResponseError extends Data.TaggedError("ApnsInvalidResponseError")<{
  readonly cause: unknown;
}> {}

export type ApnsError = ApnsSigningError | ApnsHttpRequestError | ApnsInvalidResponseError;

const decodeApnsErrorResponseJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      reason: Schema.optional(Schema.String),
    }),
  ),
);

function makeApnsJwt(input: {
  readonly teamId: ApnsCredentials["teamId"];
  readonly keyId: ApnsCredentials["keyId"];
  readonly privateKey: ApnsCredentials["privateKey"];
  readonly issuedAtUnixSeconds: number;
}): Effect.Effect<string, ApnsSigningError> {
  return Effect.try({
    try: () => {
      const keyId = Redacted.value(input.keyId);
      const teamId = Redacted.value(input.teamId);
      const privateKey = Redacted.value(input.privateKey);
      const header = Encoding.encodeBase64Url(JSON.stringify({ alg: "ES256", kid: keyId }));
      const payload = Encoding.encodeBase64Url(
        JSON.stringify({ iss: teamId, iat: input.issuedAtUnixSeconds }),
      );
      const signingInput = `${header}.${payload}`;
      const signature = NodeCrypto.createSign("sha256")
        .update(signingInput)
        .sign({
          key: privateKey.replace(/\\n/g, "\n"),
          dsaEncoding: "ieee-p1363",
        });
      return `${signingInput}.${Encoding.encodeBase64Url(signature)}`;
    },
    catch: (cause) => new ApnsSigningError({ cause }),
  });
}

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

export type MakeLiveActivityRequestInput =
  | (LiveActivityRequestBase & {
      readonly event: "end";
      readonly state: RelayAgentActivityAggregateState | null;
    })
  | (LiveActivityRequestBase & {
      readonly event: "start" | "update";
      readonly state: RelayAgentActivityAggregateState;
    });

export function makeLiveActivityRequest(
  input: MakeLiveActivityRequestInput,
): ApnsLiveActivityRequest {
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

export function makePushNotificationRequest(input: {
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
      threadId: input.notification.threadId,
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

export function sendLiveActivityRequest(input: {
  readonly credentials: ApnsCredentials;
  readonly request: ApnsLiveActivityRequest;
  readonly issuedAtUnixSeconds: number;
}): Effect.Effect<ApnsDeliveryResult, ApnsError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const jwt = yield* makeApnsJwt({
      ...input.credentials,
      issuedAtUnixSeconds: input.issuedAtUnixSeconds,
    });
    const host =
      input.credentials.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(`${host}/3/device/${input.request.token}`).pipe(
      HttpClientRequest.setHeaders({
        authorization: `bearer ${jwt}`,
        "apns-priority": input.request.priority,
        "apns-push-type": "liveactivity",
        "apns-topic": `${Redacted.value(input.credentials.bundleId)}.push-type.liveactivity`,
      }),
      HttpClientRequest.bodyJson(input.request.payload),
      Effect.flatMap(httpClient.execute),
      Effect.mapError((cause) => new ApnsHttpRequestError({ cause })),
    );
    const responseText = yield* response.text.pipe(
      Effect.mapError((cause) => new ApnsHttpRequestError({ cause })),
    );
    const reason = apnsReasonFromBody(responseText);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      ...(reason === undefined ? {} : { reason }),
      apnsId: Option.getOrNull(Headers.get(response.headers, "apns-id")),
    };
  });
}

export function sendPushNotificationRequest(input: {
  readonly credentials: ApnsCredentials;
  readonly request: ApnsPushNotificationRequest;
  readonly issuedAtUnixSeconds: number;
}): Effect.Effect<ApnsDeliveryResult, ApnsError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const jwt = yield* makeApnsJwt({
      ...input.credentials,
      issuedAtUnixSeconds: input.issuedAtUnixSeconds,
    });
    const host =
      input.credentials.environment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(`${host}/3/device/${input.request.token}`).pipe(
      HttpClientRequest.setHeaders({
        authorization: `bearer ${jwt}`,
        "apns-priority": input.request.priority,
        "apns-push-type": "alert",
        "apns-topic": Redacted.value(input.credentials.bundleId),
      }),
      HttpClientRequest.bodyJson(input.request.payload),
      Effect.flatMap(httpClient.execute),
      Effect.mapError((cause) => new ApnsHttpRequestError({ cause })),
    );
    const responseText = yield* response.text.pipe(
      Effect.mapError((cause) => new ApnsHttpRequestError({ cause })),
    );
    const reason = apnsReasonFromBody(responseText);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      ...(reason === undefined ? {} : { reason }),
      apnsId: Option.getOrNull(Headers.get(response.headers, "apns-id")),
    };
  });
}
