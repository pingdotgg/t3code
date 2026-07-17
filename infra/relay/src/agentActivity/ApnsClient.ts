import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { ApnsEnvironment as ApnsEnvironmentSchema, type ApnsCredentials } from "../Config.ts";
import type { ApnsLiveActivityAlert, ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";
import { ApnsJwtEncodingError, ApnsJwtSigningError } from "./apnsJwt.ts";
import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";

export { ApnsJwtEncodingError, ApnsJwtSigningError } from "./apnsJwt.ts";

const LIVE_ACTIVITY_NAME = "AgentActivity";
// Updates only flow on domain events, so a healthy agent can be silent for
// minutes (long tool calls, pending approvals). Two minutes made iOS dim
// perfectly healthy activities; ten minutes still bounds how long a dead
// environment can look alive.
const STALE_AFTER_SECONDS = 10 * 60;
const DISMISS_AFTER_SECONDS = 5 * 60;
// An end without a final content-state leaves whatever the card last showed
// frozen on the lock screen until dismissal — get it off quickly instead of
// parading stale state for the full window.
const CONTENTLESS_DISMISS_AFTER_SECONDS = 15;

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
      readonly alert?: ApnsLiveActivityAlert | null;
    })
  | (LiveActivityRequestBase & {
      readonly event: "start" | "update";
      readonly state: RelayAgentActivityAggregateState;
      readonly alert?: ApnsLiveActivityAlert | null;
    });

// An alert dict on an update/end makes it an "alerting" update: iOS wakes the
// screen and plays the haptic (the Apple Sports score-change behavior) instead
// of silently redrawing the activity.
function liveActivityAlertPayload(alert: ApnsLiveActivityAlert) {
  return {
    alert: {
      title: alert.title,
      body: alert.body,
      sound: "default",
    },
  };
}

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
          ...(input.alert ? liveActivityAlertPayload(input.alert) : {}),
          "dismissal-date":
            timestamp + (input.state ? DISMISS_AFTER_SECONDS : CONTENTLESS_DISMISS_AFTER_SECONDS),
        },
      },
    };
  }

  const state = input.state;
  return {
    token: input.token,
    event: input.event,
    // Alerting updates must land immediately; routine redraws stay at the
    // budget-friendly low priority.
    priority: input.event === "update" && !input.alert ? "5" : "10",
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
        ...(input.event === "update" && input.alert ? liveActivityAlertPayload(input.alert) : {}),
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
  const providerTokens = yield* ApnsProviderTokens.ApnsProviderTokens;

  const sendLiveActivityRequest: ApnsClient["Service"]["sendLiveActivityRequest"] = Effect.fn(
    "relay.apns.send_live_activity_request",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({ "relay.apns.event": input.request.event });
    const jwt = yield* providerTokens.getJwt({
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
      const jwt = yield* providerTokens.getJwt({
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
