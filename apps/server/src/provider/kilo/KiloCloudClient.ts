import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

/** Customer bearer endpoints used by the public Kilo 7.8.3 CLI, not the private cloud SDK.
 * Reference: Kilo-Org/kilo packages/opencode/src/kilocode/cloud/{trpc,contracts}.ts.
 * This boundary deliberately cannot report that billing stopped or invent a remote Stop route.
 */
export class KiloCloudError extends Schema.TaggedError<KiloCloudError>()("KiloCloudError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "rejected",
    "not_found",
    "admission_unknown",
    "invalid_response",
    "wrong_owner",
    "unsupported",
    "recovery_incomplete",
    "recovery_limit",
  ]),
  recoveryCause: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.String),
}) {}

export const KiloCloudRef = Schema.Struct({
  accountKey: Schema.NonEmptyString,
  sessionId: Schema.String.check(Schema.isPattern(/^agent_[0-9a-f-]{36}$/i)),
  messageId: Schema.String.check(Schema.isPattern(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)),
});
export type KiloCloudRef = typeof KiloCloudRef.Type;
const Admission = Schema.Struct({
  cloudAgentSessionId: KiloCloudRef.fields.sessionId,
  kiloSessionId: Schema.optional(Schema.String),
  messageId: KiloCloudRef.fields.messageId,
  delivery: Schema.NonEmptyString,
});
const Result = Schema.Struct({
  cloudAgentSessionId: KiloCloudRef.fields.sessionId,
  messageId: KiloCloudRef.fields.messageId,
  status: Schema.Literals(["queued", "running", "completed", "failed", "interrupted"]),
  createdAt: Schema.Number,
  terminalAt: Schema.optional(Schema.Number),
  assistant: Schema.optional(
    Schema.Struct({ messageId: Schema.String, text: Schema.optional(Schema.String) }),
  ),
});
const Envelope = Schema.Struct({ result: Schema.Struct({ data: Schema.Unknown }) });
const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope));
const decodeAdmission = Schema.decodeUnknownEffect(Admission);
const decodeResult = Schema.decodeUnknownEffect(Result);
const isCloudError = Schema.is(KiloCloudError);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const make = (input: {
  readonly accountKey: string;
  readonly apiKey: Redacted.Redacted<string>;
  /** Only the production customer endpoint or a local contract-test server. */
  readonly origin?: string;
}) => {
  const origin = input.origin ?? "https://cloud-agent-next.kilosessions.ai";
  const allowedOrigin =
    origin === "https://cloud-agent-next.kilosessions.ai" ||
    /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
  const own = (ref: KiloCloudRef) =>
    ref.accountKey === input.accountKey
      ? Effect.void
      : Effect.fail(new KiloCloudError({ operation: "ownership", reason: "wrong_owner" }));
  const request = (
    operation: "start" | "send" | "getMessageResult",
    body: unknown,
    messageId: string,
  ) => {
    const mutation = operation !== "getMessageResult";
    const uncertain = () =>
      new KiloCloudError({
        operation,
        reason: mutation ? "admission_unknown" : "invalid_response",
        messageId,
      });
    if (!allowedOrigin) return Effect.fail(new KiloCloudError({ operation, reason: "rejected" }));
    return Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const req = HttpClientRequest.make(mutation ? "POST" : "GET")(
        `${origin}/trpc/${operation}${mutation ? "" : `?input=${encodeURIComponent(encode(body))}`}`,
        {
          headers: {
            authorization: `Bearer ${Redacted.value(input.apiKey)}`,
            "content-type": "application/json",
          },
        },
      );
      const response = yield* client.execute(
        mutation ? HttpClientRequest.bodyText(req, encode(body), "application/json") : req,
      );
      if (response.status < 200 || response.status >= 300)
        return yield* response.status >= 500 || response.status === 408 || response.status === 409
          ? uncertain()
          : new KiloCloudError({ operation, reason: "rejected", messageId });
      const bytes = yield* response.stream.pipe(
        Stream.runFoldEffect(
          () => ({ size: 0, chunks: [] as Uint8Array[] }),
          (acc, chunk) =>
            acc.size + chunk.byteLength > 1024 * 1024
              ? Effect.fail(uncertain())
              : Effect.succeed({
                  size: acc.size + chunk.byteLength,
                  chunks: [...acc.chunks, chunk],
                }),
        ),
      );
      return yield* decodeEnvelope(Buffer.concat(bytes.chunks).toString("utf8")).pipe(
        Effect.map((envelope) => envelope.result.data),
      );
    }).pipe(
      Effect.scoped,
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provide(FetchHttpClient.layer),
      Effect.timeout("30 seconds"),
      Effect.mapError((error) => (isCloudError(error) ? error : uncertain())),
    );
  };

  const admit = (
    operation: "start" | "send",
    body: unknown,
    messageId: string,
    sessionId?: string,
  ) =>
    request(operation, body, messageId).pipe(
      Effect.flatMap((raw) =>
        decodeAdmission(raw).pipe(
          Effect.mapError(
            () => new KiloCloudError({ operation, reason: "admission_unknown", messageId }),
          ),
        ),
      ),
      Effect.flatMap((accepted) =>
        accepted.messageId !== messageId ||
        (sessionId !== undefined && accepted.cloudAgentSessionId !== sessionId)
          ? Effect.fail(new KiloCloudError({ operation, reason: "admission_unknown", messageId }))
          : Effect.succeed({
              accountKey: input.accountKey,
              sessionId: accepted.cloudAgentSessionId,
              messageId,
            }),
      ),
    );
  return {
    /** The caller must durably persist this message ID BEFORE submitting. An unknown start has
     * no session ID to query through this customer API; operator reconciliation is required.
     */
    start: (request: {
      readonly messageId: string;
      readonly prompt: string;
      readonly repository: {
        readonly type: "github";
        readonly repo: string;
        readonly branch?: string;
      };
      readonly model: string;
      readonly mode: string;
    }) =>
      admit(
        "start",
        {
          message: { id: request.messageId, prompt: request.prompt },
          repository: request.repository,
          agent: { model: request.model, mode: request.mode },
          options: { createdOnPlatform: "kilo-cli" },
        },
        request.messageId,
      ),
    send: (ref: KiloCloudRef, messageId: string, prompt: string) =>
      own(ref).pipe(
        Effect.andThen(
          admit(
            "send",
            { cloudAgentSessionId: ref.sessionId, message: { id: messageId, prompt } },
            messageId,
            ref.sessionId,
          ),
        ),
      ),
    result: (ref: KiloCloudRef) =>
      own(ref).pipe(
        Effect.andThen(
          request(
            "getMessageResult",
            { cloudAgentSessionId: ref.sessionId, messageId: ref.messageId },
            ref.messageId,
          ),
        ),
        Effect.flatMap((raw) =>
          decodeResult(raw).pipe(
            Effect.mapError(
              () =>
                new KiloCloudError({ operation: "getMessageResult", reason: "invalid_response" }),
            ),
          ),
        ),
        Effect.flatMap((result) =>
          result.cloudAgentSessionId !== ref.sessionId || result.messageId !== ref.messageId
            ? Effect.fail(
                new KiloCloudError({ operation: "getMessageResult", reason: "wrong_owner" }),
              )
            : Effect.succeed({ ...result, billingStatus: "unknown" as const }),
        ),
      ),
    interrupt: (ref: KiloCloudRef) =>
      own(ref).pipe(
        Effect.andThen(
          Effect.fail(new KiloCloudError({ operation: "interrupt", reason: "unsupported" })),
        ),
      ),
  };
};
