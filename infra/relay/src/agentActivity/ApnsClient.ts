import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Headers from "effect/http/Headers";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ApnsEnvironment, type ApnsCredentials } from "../Config.ts";
import { type AgentActivityCopy, localizeAggregateState } from "./agentActivityCopy.ts";
import { MAX_SUMMARY_TEXT_LENGTH, truncateText } from "./agentActivityPayloads.ts";
import type { ApnsLiveActivityAlert, ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";
import type { ApnsJwtEncodingError, ApnsJwtSigningError } from "./apnsJwt.ts";
import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";

export { ApnsJwtEncodingError, ApnsJwtSigningError } from "./apnsJwt.ts";

const LIVE_ACTIVITY_NAME = "AgentActivity";
// Bound sending and reading separately so neither stage can hold a batch open.
const APNS_HTTP_STAGE_TIMEOUT = "10 seconds";
// Event-only updates can leave healthy agents silent for minutes.
const STALE_AFTER_SECONDS = 10 * 60;
const DISMISS_AFTER_SECONDS = 5 * 60;
// Without final content, the card freezes at stale state; dismiss it promptly.
const CONTENTLESS_DISMISS_AFTER_SECONDS = 15;
const MAX_LIVE_ACTIVITY_PAYLOAD_BYTES = 4096;
const MIN_FITTED_TEXT_LENGTH = 8;

const ApnsLiveActivityEventSchema = Schema.Literals(["update", "end"]);
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

export class ApnsHttpRequestError extends Schema.TaggedError<ApnsHttpRequestError>()(
  "ApnsHttpRequestError",
  {
    requestKind: ApnsRequestKindSchema,
    event: Schema.NullOr(ApnsLiveActivityEventSchema),
    environment: ApnsEnvironment,
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

export type ApnsError = ApnsJwtEncodingError | ApnsJwtSigningError | ApnsHttpRequestError;

const decodeApnsErrorResponseJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      reason: Schema.optional(Schema.String),
    }),
  ),
);
// Pushed props replace the ones the app started the activity with, translated text included.
function contentState(
  state: RelayAgentActivityAggregateState,
  copy: AgentActivityCopy | undefined,
) {
  return {
    name: LIVE_ACTIVITY_NAME,
    props: JSON.stringify(
      copy ? { ...localizeAggregateState(state, copy), text: copy.text(state) } : state,
    ),
  };
}

interface LiveActivityRequestBase {
  readonly token: string;
  readonly nowEpochSeconds: number;
  readonly nowIso: string;
  readonly copy?: AgentActivityCopy | undefined;
}

type MakeLiveActivityRequestInput =
  | (LiveActivityRequestBase & {
      readonly event: "end";
      readonly state: RelayAgentActivityAggregateState | null;
      readonly alert?: ApnsLiveActivityAlert | null;
    })
  | (LiveActivityRequestBase & {
      readonly event: "update";
      readonly state: RelayAgentActivityAggregateState;
      readonly alert?: ApnsLiveActivityAlert | null;
    });

// Alert dictionaries wake the iOS screen and trigger haptics instead of silently refreshing.
function liveActivityAlertPayload(alert: ApnsLiveActivityAlert) {
  return {
    alert: {
      title: alert.title,
      body: alert.body,
      sound: "default",
    },
  };
}

// Text caps count characters, so multibyte titles can overflow APNs' 4 KB
// limit. Shorten titles and alert text until the encoded payload fits. Links
// and ids can't shrink, so if the shortest text still overflows, drop the last
// (lowest-priority) row and fit again.
function makeLiveActivityRequest(input: MakeLiveActivityRequestInput): ApnsLiveActivityRequest {
  let request = buildLiveActivityRequest(input);
  const state = input.state;
  if (state === null) {
    return request;
  }
  const fit = (maxTextLength: number, rowCount: number) =>
    buildLiveActivityRequest({
      ...input,
      state: {
        ...state,
        activities: state.activities.slice(0, rowCount).map((row) => ({
          ...row,
          projectTitle: truncateText(row.projectTitle, maxTextLength),
          threadTitle: truncateText(row.threadTitle, maxTextLength),
          modelTitle: truncateText(row.modelTitle, maxTextLength),
        })),
      },
      alert: input.alert
        ? {
            title: truncateText(input.alert.title, maxTextLength),
            body: truncateText(input.alert.body, maxTextLength),
          }
        : null,
    });
  let rowCount = state.activities.length;
  let maxTextLength = MAX_SUMMARY_TEXT_LENGTH;
  while (
    !fitsLiveActivityLimit(request) &&
    (rowCount > 0 || maxTextLength > MIN_FITTED_TEXT_LENGTH)
  ) {
    if (maxTextLength > MIN_FITTED_TEXT_LENGTH) {
      maxTextLength = Math.floor(maxTextLength * 0.8);
    } else {
      rowCount -= 1;
      maxTextLength = MAX_SUMMARY_TEXT_LENGTH;
    }
    request = fit(maxTextLength, rowCount);
  }
  return request;
}

function fitsLiveActivityLimit(request: ApnsLiveActivityRequest): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(request.payload)).byteLength <=
    MAX_LIVE_ACTIVITY_PAYLOAD_BYTES
  );
}

function buildLiveActivityRequest(input: MakeLiveActivityRequestInput): ApnsLiveActivityRequest {
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
          ...(input.state ? { "content-state": contentState(input.state, input.copy) } : {}),
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
    priority: input.event === "update" && !input.alert ? "5" : "10",
    payload: {
      aps: {
        timestamp,
        event: input.event,
        ...(input.event === "update" && input.alert ? liveActivityAlertPayload(input.alert) : {}),
        "content-state": contentState(state, input.copy),
        "stale-date": timestamp + STALE_AFTER_SECONDS,
      },
    },
  };
}

function notificationThreadId(notification: ApnsNotificationPayload): string {
  return notification.threadId.length > 0
    ? `${notification.environmentId}/${notification.threadId}`
    : "t3-agent-alerts";
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
        "thread-id": notificationThreadId(input.notification),
      },
      // Expo iOS exposes userInfo.body as notification.content.data for remote pushes.
      body: {
        environmentId: input.notification.environmentId,
        threadId: input.notification.threadId,
        deepLink: input.notification.deepLink,
      },
    },
  };
}

// The request URL ends in the device token. The client span records the URL,
// and so does an HTTP client error's message, so neither reaches telemetry.
const withoutClientSpan = Effect.provideService(HttpClient.TracerDisabledWhen, () => true);

function causeWithoutRequestUrl(cause: unknown): unknown {
  return HttpClientError.isHttpClientError(cause)
    ? new Error(cause.reason._tag, { cause: cause.reason.cause })
    : cause;
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

const make = Effect.gen(function* () {
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
      withoutClientSpan,
      Effect.timeout(APNS_HTTP_STAGE_TIMEOUT),
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
            cause: causeWithoutRequestUrl(cause),
          }),
      ),
    );
    const responseText = yield* response.text.pipe(
      Effect.timeout(APNS_HTTP_STAGE_TIMEOUT),
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
            cause: causeWithoutRequestUrl(cause),
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
        withoutClientSpan,
        Effect.timeout(APNS_HTTP_STAGE_TIMEOUT),
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
              cause: causeWithoutRequestUrl(cause),
            }),
        ),
      );
      const responseText = yield* response.text.pipe(
        Effect.timeout(APNS_HTTP_STAGE_TIMEOUT),
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
              cause: causeWithoutRequestUrl(cause),
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
