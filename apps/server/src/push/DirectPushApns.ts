// @effect-diagnostics nodeBuiltinImport:off -- APNs requires HTTP/2, which Node's fetch does not speak, and Effect's crypto has no ES256 signing.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

import type { DirectPushApsEnvironment } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: string;
}

export interface ApnsAlertPayload {
  readonly aps: {
    readonly alert: { readonly title: string; readonly body: string };
    readonly sound: "default";
    readonly "thread-id": string;
  };
  /** Expo exposes this as the notification's data; the app opens `deepLink` on tap. */
  readonly body?: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly deepLink: string;
  };
}

export interface ApnsResponse {
  readonly status: number;
  /** APNs' `reason`, such as `BadDeviceToken` or `Unregistered`. */
  readonly reason: string | null;
}

export class DirectPushApnsError extends Schema.TaggedError<DirectPushApnsError>()(
  "DirectPushApnsError",
  {
    stage: Schema.Literals(["sign", "send"]),
    environment: Schema.Literals(["sandbox", "production"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.stage === "sign"
      ? "Could not sign the APNs provider token."
      : `Could not reach the ${this.environment} APNs service.`;
  }
}

export const isDirectPushApnsError = Schema.is(DirectPushApnsError);

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class DirectPushApns extends Context.Service<
  DirectPushApns,
  {
    readonly send: (input: {
      readonly credentials: ApnsCredentials;
      readonly environment: DirectPushApsEnvironment;
      readonly token: string;
      readonly bundleId: string;
      readonly payload: ApnsAlertPayload;
    }) => Effect.Effect<ApnsResponse, DirectPushApnsError>;
  }
>()("t3/push/DirectPushApns") {}

const APNS_HOSTS = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
} as const;

// APNs rejects provider tokens older than an hour and refreshes more often than every 20 minutes.
const PROVIDER_TOKEN_REUSE_MS = 50 * 60 * 1_000;

/** The key object for a `.p8` PEM, which may arrive with literal `\n` escapes from a form field. */
export function parseApnsPrivateKey(pem: string): NodeCrypto.KeyObject {
  const key = NodeCrypto.createPrivateKey(pem.replace(/\\n/g, "\n"));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("APNs signing keys are P-256 EC keys.");
  }
  return key;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signProviderToken(credentials: ApnsCredentials, issuedAtSeconds: number): string {
  const signingInput = `${base64UrlJson({ alg: "ES256", kid: credentials.keyId })}.${base64UrlJson({
    iss: credentials.teamId,
    iat: issuedAtSeconds,
  })}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: parseApnsPrivateKey(credentials.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function readReason(body: string): string | null {
  if (body.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" &&
      parsed !== null &&
      "reason" in parsed &&
      typeof parsed.reason === "string"
      ? parsed.reason
      : null;
  } catch {
    return null;
  }
}

const make = Effect.gen(function* () {
  const sessions = new Map<string, NodeHttp2.ClientHttp2Session>();
  const providerTokens = new Map<string, { readonly jwt: string; readonly issuedAtMs: number }>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    }),
  );

  const sessionFor = (host: string): NodeHttp2.ClientHttp2Session => {
    const existing = sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = NodeHttp2.connect(host);
    // An idle session must not keep the server process alive.
    session.unref();
    const forget = () => {
      if (sessions.get(host) === session) sessions.delete(host);
    };
    session.on("error", forget);
    session.on("close", forget);
    session.on("goaway", forget);
    sessions.set(host, session);
    return session;
  };

  const providerToken = Effect.fnUntraced(function* (credentials: ApnsCredentials) {
    const fingerprint = NodeCrypto.createHash("sha256")
      .update(credentials.privateKey)
      .digest("hex")
      .slice(0, 16);
    const cacheKey = `${credentials.teamId}:${credentials.keyId}:${fingerprint}`;
    const now = yield* Clock.currentTimeMillis;
    const cached = providerTokens.get(cacheKey);
    if (cached && now - cached.issuedAtMs < PROVIDER_TOKEN_REUSE_MS) return cached.jwt;
    const jwt = signProviderToken(credentials, Math.floor(now / 1_000));
    providerTokens.set(cacheKey, { jwt, issuedAtMs: now });
    return jwt;
  });

  const send: DirectPushApns["Service"]["send"] = Effect.fn("DirectPushApns.send")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "apns.environment": input.environment,
        "apns.token_suffix": input.token.slice(-8),
      });
      const jwt = yield* providerToken(input.credentials).pipe(
        // Signing only throws on a key setCredentials already validated, such as a corrupted store.
        Effect.catchDefect((cause) =>
          Effect.fail(
            new DirectPushApnsError({ stage: "sign", environment: input.environment, cause }),
          ),
        ),
      );
      const body = yield* encodePayload(input.payload).pipe(
        Effect.mapError(
          (cause) =>
            new DirectPushApnsError({ stage: "send", environment: input.environment, cause }),
        ),
      );
      return yield* Effect.callback<ApnsResponse, DirectPushApnsError>((resume) => {
        const fail = (cause: unknown) =>
          resume(
            Effect.fail(
              new DirectPushApnsError({ stage: "send", environment: input.environment, cause }),
            ),
          );
        let request: NodeHttp2.ClientHttp2Stream;
        try {
          request = sessionFor(APNS_HOSTS[input.environment]).request({
            ":method": "POST",
            ":path": `/3/device/${input.token}`,
            authorization: `bearer ${jwt}`,
            "apns-topic": input.bundleId,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "content-type": "application/json",
          });
        } catch (cause) {
          fail(cause);
          return;
        }
        let status = 0;
        let responseBody = "";
        request.setEncoding("utf8");
        request.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
        });
        request.on("data", (chunk: Buffer | string) => {
          responseBody += String(chunk);
        });
        request.on("end", () =>
          resume(Effect.succeed({ status, reason: readReason(responseBody) })),
        );
        request.on("error", fail);
        request.end(body);
        return Effect.sync(() => {
          if (!request.closed) request.close(NodeHttp2.constants.NGHTTP2_CANCEL);
        });
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.catchTags({
          TimeoutError: (cause) =>
            Effect.fail(
              new DirectPushApnsError({ stage: "send", environment: input.environment, cause }),
            ),
        }),
      );
    },
  );

  return DirectPushApns.of({ send });
});

export const layer = Layer.effect(DirectPushApns, make);
