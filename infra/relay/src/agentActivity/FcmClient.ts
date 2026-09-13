import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import * as RelayConfiguration from "../Config.ts";
import * as FcmAssertionSigner from "./FcmAssertionSigner.ts";

const FCM_HTTP_STAGE_TIMEOUT = "10 seconds";

const ServiceAccount = Schema.Struct({
  project_id: Schema.NonEmptyString,
  client_email: Schema.NonEmptyString,
  private_key: Schema.NonEmptyString,
});
const decodeServiceAccount = Schema.decodeUnknownOption(Schema.fromJsonString(ServiceAccount));
const decodeAccessToken = Schema.decodeUnknownEffect(
  Schema.Struct({ access_token: Schema.NonEmptyString }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFcmError = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.Struct({
      status: Schema.optional(Schema.String),
      details: Schema.optional(
        Schema.Array(
          Schema.Struct({
            "@type": Schema.optional(Schema.String),
            errorCode: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  }),
);

export class FcmClientError extends Schema.TaggedError<FcmClientError>()("FcmClientError", {
  operation: Schema.Literals(["configuration", "authorize", "send"]),
  status: Schema.NullOr(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `FCM ${this.operation} failed${this.status === null ? "" : ` (${this.status})`}.`;
  }
}

export class FcmClient extends Context.Service<
  FcmClient,
  {
    readonly send: (input: {
      readonly token: string;
      readonly packageName: string | null;
      readonly data: Readonly<Record<string, string>>;
      readonly alert: boolean;
    }) => Effect.Effect<{ readonly unregistered: boolean }, FcmClientError>;
  }
>()("t3code-relay/agentActivity/FcmClient") {}

export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const signer = yield* FcmAssertionSigner.FcmAssertionSigner;
  const client = yield* HttpClient.HttpClient;
  const account = config.fcmServiceAccount
    ? decodeServiceAccount(Redacted.value(config.fcmServiceAccount))
    : Option.none();
  const authorize = Effect.gen(function* () {
    if (Option.isNone(account))
      return yield* new FcmClientError({ operation: "configuration", status: null });
    const now = yield* DateTime.now;
    const assertion = yield* signer
      .sign({
        privateKey: account.value.private_key,
        clientEmail: account.value.client_email,
        issuedAt: Math.floor(now.epochMilliseconds / 1000),
      })
      .pipe(
        Effect.mapError(
          (cause) => new FcmClientError({ operation: "authorize", status: null, cause }),
        ),
      );
    const response = yield* client
      .execute(
        HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }),
        ),
      )
      .pipe(
        Effect.timeout(FCM_HTTP_STAGE_TIMEOUT),
        Effect.mapError(
          (cause) => new FcmClientError({ operation: "authorize", status: null, cause }),
        ),
      );
    if (response.status !== 200)
      return yield* new FcmClientError({ operation: "authorize", status: response.status });
    return yield* response.json.pipe(
      Effect.timeout(FCM_HTTP_STAGE_TIMEOUT),
      Effect.flatMap(decodeAccessToken),
      Effect.map((body) => body.access_token),
      Effect.mapError(
        (cause) => new FcmClientError({ operation: "authorize", status: response.status, cause }),
      ),
    );
  });
  const [accessToken, invalidateToken] = yield* Effect.cachedInvalidateWithTTL(
    authorize,
    "50 minutes",
  );

  return FcmClient.of({
    send: Effect.fn("relay.fcm.send")(function* (input) {
      if (new TextEncoder().encode(encodeJson(input.data)).length > 4096)
        return yield* new FcmClientError({ operation: "send", status: null });
      if (Option.isNone(account))
        return yield* new FcmClientError({ operation: "configuration", status: null });
      const token = yield* accessToken.pipe(Effect.tapError(() => invalidateToken));
      const response = yield* HttpClientRequest.post(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.value.project_id)}/messages:send`,
      ).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJson({
          message: {
            token: input.token,
            data: input.data,
            android: {
              priority: "HIGH",
              ttl: "300s",
              ...(!input.alert ? { collapse_key: "t3-agent-activity" } : {}),
              ...(input.packageName ? { restricted_package_name: input.packageName } : {}),
            },
          },
        }),
        Effect.flatMap(client.execute),
        Effect.timeout(FCM_HTTP_STAGE_TIMEOUT),
        Effect.mapError((cause) => new FcmClientError({ operation: "send", status: null, cause })),
      );
      if (response.status >= 200 && response.status < 300) return { unregistered: false };
      if (response.status === 401) yield* invalidateToken;
      const body = yield* response.json.pipe(
        Effect.timeout(FCM_HTTP_STAGE_TIMEOUT),
        Effect.mapError(
          (cause) => new FcmClientError({ operation: "send", status: response.status, cause }),
        ),
      );
      const decoded = decodeFcmError(body);
      const unregistered =
        Option.isSome(decoded) &&
        decoded.value.error.details?.some(
          (detail) =>
            detail["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError" &&
            detail.errorCode === "UNREGISTERED",
        ) === true;
      if (unregistered) return { unregistered: true };
      return yield* new FcmClientError({ operation: "send", status: response.status });
    }),
  });
});

export const layer = Layer.effect(FcmClient, make);
