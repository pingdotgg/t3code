import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";

import {
  ProtoReader,
  encode,
  frame,
  message,
  parseGrpcWebBody,
  statusFromHeaders,
} from "./boxdCloudProto.ts";

/**
 * A thin client for the parts of boxd's gRPC API that boxd cloud uses, over grpc-web so
 * it needs only an HTTP client. An API key buys a JWT that lasts an hour; the client keeps it.
 */

const BOXD_API_URL = "https://boxd.sh:9443/boxd.api.v1.BoxdApi";
const BOXD_TOKEN_URL = "https://app.boxd.sh/api/v1/auth/token";
/** boxd serves a machine's proxied port at this domain. */
const BOXD_HOST_SUFFIX = ".boxd.sh";

export class BoxdApiError extends Schema.TaggedError<BoxdApiError>()("BoxdApiError", {
  /** The gRPC status, or the HTTP status when boxd answered outside gRPC; 0 for no answer. */
  status: Schema.Number,
  code: Schema.String,
  /** Fixed or built from the status; boxd's own text and VM output stay in `cause`. */
  message: Schema.String,
  retryable: Schema.Boolean,
  cause: Schema.optional(Schema.Defect()),
}) {}

const GRPC_NOT_FOUND = 5;
const GRPC_PERMISSION_DENIED = 7;
const GRPC_UNAVAILABLE = 14;
const GRPC_UNAUTHENTICATED = 16;

export interface BoxdMachine {
  readonly id: string;
  readonly name: string;
  /** `running`, `suspended`, `hibernated` or `stopped`, among others while it changes. */
  readonly status: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Where boxd serves the machine's proxied port. */
  readonly url: string;
}

export interface BoxdSnapshot {
  readonly name: string;
  /** `pending`, `ready` or `failed`. */
  readonly status: string;
  /** Epoch milliseconds; moves with every new version. */
  readonly updatedAt: number;
}

export interface BoxdCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const machineOf = (vm: ProtoReader): BoxdMachine => ({
  id: vm.string(1),
  name: vm.string(2),
  status: vm.string(5),
  labels: vm.map(34),
  url: `https://${vm.string(2)}${BOXD_HOST_SUFFIX}`,
});

const snapshotOf = (snapshot: ProtoReader): BoxdSnapshot => ({
  name: snapshot.string(2),
  status: snapshot.string(4),
  updatedAt: snapshot.number(8),
});

const Token = Schema.Struct({ token: Schema.String, expires_at: Schema.Number });
const decodeToken = Schema.decodeUnknownEffect(Token);

/** A token is renewed this long before boxd says it expires. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
// Calls right after a create can land while boxd still routes the machine.
const transientRetry = Schedule.spaced(Duration.seconds(1));
const textDecoder = new TextDecoder();

export function makeBoxdApi(http: HttpClient.HttpClient, apiKey: string) {
  let token: { readonly value: string; readonly expiresAt: number } | null = null;
  const tokenLock = Semaphore.makeUnsafe(1);

  const failure = (status: number, code: string, message: string, cause?: unknown) =>
    new BoxdApiError({
      status,
      code,
      message,
      retryable: status === GRPC_UNAVAILABLE || code === "network",
      cause,
    });

  const exchange = Effect.gen(function* () {
    const response = yield* http
      .execute(
        HttpClientRequest.post(BOXD_TOKEN_URL).pipe(
          HttpClientRequest.bodyJsonUnsafe({ api_key: apiKey }),
        ),
      )
      .pipe(Effect.mapError((cause) => failure(0, "network", "Could not reach boxd.", cause)));
    if (response.status === 401 || response.status === 403) {
      return yield* failure(GRPC_UNAUTHENTICATED, "unauthenticated", "boxd rejected the API key.");
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* failure(
        response.status,
        `http_${response.status}`,
        `boxd answered ${response.status}.`,
      );
    }
    const body = yield* response.json.pipe(
      Effect.flatMap(decodeToken),
      Effect.mapError((cause) =>
        failure(
          response.status,
          "invalid_response",
          "boxd returned an unexpected response.",
          cause,
        ),
      ),
    );
    token = { value: body.token, expiresAt: body.expires_at * 1000 };
    return body.token;
  });

  const currentToken = Effect.flatMap(Clock.currentTimeMillis, (now) =>
    token !== null && token.expiresAt - now > TOKEN_MARGIN_MS
      ? Effect.succeed(token.value)
      : exchange,
  ).pipe(tokenLock.withPermits(1));

  const callOnce = Effect.fn("BoxdApi.call")(
    function* (method: string, body: Uint8Array, _timeout: Duration.Input) {
      const jwt = yield* currentToken;
      const response = yield* http
        .execute(
          HttpClientRequest.post(`${BOXD_API_URL}/${method}`).pipe(
            HttpClientRequest.bearerToken(jwt),
            HttpClientRequest.bodyUint8Array(frame(body), "application/grpc-web+proto"),
          ),
        )
        .pipe(Effect.mapError((cause) => failure(0, "network", "Could not reach boxd.", cause)));
      if (response.status !== 200) {
        return yield* failure(
          response.status === 401 ? GRPC_UNAUTHENTICATED : response.status,
          `http_${response.status}`,
          `boxd answered ${response.status}.`,
        );
      }
      const bytes = yield* response.arrayBuffer.pipe(
        Effect.mapError((cause) => failure(0, "network", "Could not read boxd's answer.", cause)),
      );
      const parsed = parseGrpcWebBody(new Uint8Array(bytes));
      const status = parsed.status ?? statusFromHeaders(response.headers)?.status ?? 0;
      if (status !== 0) {
        const detail = parsed.message || statusFromHeaders(response.headers)?.message || "";
        return yield* failure(
          status,
          status === GRPC_NOT_FOUND
            ? "not_found"
            : status === GRPC_PERMISSION_DENIED
              ? "permission_denied"
              : status === GRPC_UNAUTHENTICATED
                ? "unauthenticated"
                : `grpc_${status}`,
          `boxd could not ${method}: ${detail || `status ${status}`}.`,
          detail,
        );
      }
      return parsed.messages;
    },
    (effect, _method, _body, timeout) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(failure(0, "timeout", "boxd did not answer in time.")),
        }),
      ),
  );

  /** One call; an expired token is renewed once, and an unavailable boxd retried briefly. */
  const call = (method: string, body: Uint8Array, timeout: Duration.Input = Duration.seconds(30)) =>
    callOnce(method, body, timeout).pipe(
      Effect.catchIf(
        (error) => error.status === GRPC_UNAUTHENTICATED && token !== null,
        () =>
          Effect.sync(() => {
            token = null;
          }).pipe(Effect.andThen(callOnce(method, body, timeout))),
      ),
      Effect.retry({ schedule: transientRetry, times: 5, while: (error) => error.retryable }),
    );

  const first = (messages: ReadonlyArray<Uint8Array>) =>
    new ProtoReader(messages[0] ?? new Uint8Array());
  const orNull = <A>(effect: Effect.Effect<A, BoxdApiError>) =>
    effect.pipe(
      Effect.catchIf(
        (error) => error.status === GRPC_NOT_FOUND,
        () => Effect.succeed(null),
      ),
    );

  const exec = (vmId: string, command: string, timeoutSeconds = 120) =>
    callOnce(
      "Exec",
      encode(message([4, command], [5, vmId])),
      Duration.seconds(timeoutSeconds),
    ).pipe(
      Effect.map((messages): BoxdCommandResult => {
        let stdout = "";
        let stderr = "";
        let exitCode: number | null = null;
        for (const chunk of messages) {
          const reader = new ProtoReader(chunk);
          const data = reader.bytes(1);
          if (data.length === 0) {
            // The last chunk carries no output, only the exit code (absent on the wire when 0).
            exitCode = reader.number(6);
          } else if (reader.bool(10)) {
            stderr += textDecoder.decode(data);
          } else {
            stdout += textDecoder.decode(data);
          }
        }
        return { exitCode, stdout, stderr };
      }),
    );

  return {
    /** The account's display name, which also proves the key works. */
    whoami: () =>
      call("Whoami", encode(message())).pipe(
        Effect.map((messages) => {
          const reply = first(messages);
          return reply.string(5) || reply.string(1) || "boxd account";
        }),
      ),
    createMachine: (input: {
      readonly name: string;
      readonly labels: Readonly<Record<string, string>>;
      /** A ready snapshot to copy, memory and disk; a fresh machine when absent. */
      readonly snapshot?: string;
    }) =>
      (input.snapshot === undefined
        ? call(
            "CreateVm",
            encode(message([1, input.name], [14, input.labels])),
            Duration.minutes(2),
          )
        : call(
            "CreateVmFromSnapshot",
            encode(message([1, input.snapshot], [2, input.name], [6, input.labels])),
            Duration.minutes(2),
          )
      ).pipe(
        Effect.map((messages): BoxdMachine => {
          const reply = first(messages);
          const machine = reply.message(9);
          if (machine !== null) return machineOf(machine);
          return {
            id: reply.string(1),
            name: reply.string(2),
            status: reply.string(6),
            labels: input.labels,
            url: `https://${reply.string(2)}${BOXD_HOST_SUFFIX}`,
          };
        }),
      ),
    listMachines: (labelSelector: ReadonlyArray<string>) =>
      call("ListVms", encode(message([3, labelSelector]))).pipe(
        Effect.map((messages) => first(messages).messages(1).map(machineOf)),
      ),
    getMachine: (vmId: string) =>
      orNull(
        call("GetVm", encode(message([1, vmId]))).pipe(
          Effect.map((messages) => machineOf(first(messages))),
        ),
      ),
    destroy: (vmId: string) =>
      orNull(call("DestroyVm", encode(message([1, vmId])))).pipe(Effect.asVoid),
    start: (vmId: string) =>
      call("StartVm", encode(message([1, vmId])), Duration.minutes(2)).pipe(Effect.asVoid),
    exec: (vmId: string, command: string, timeoutSeconds?: number) =>
      exec(vmId, command, timeoutSeconds).pipe(
        Effect.retry({ schedule: transientRetry, times: 10, while: (error) => error.retryable }),
      ),
    updateLabels: (
      vmId: string,
      set: Readonly<Record<string, string>>,
      remove: ReadonlyArray<string> = [],
    ) =>
      call("UpdateVmLabels", encode(message([1, vmId], [2, set], [3, remove]))).pipe(Effect.asVoid),
    /** Serves `port` at the machine's URL. The default proxy is the one named "". */
    setProxyPort: (vmId: string, port: number) =>
      call("SetProxyPort", encode(message([3, String(port)], [4, vmId]))).pipe(Effect.asVoid),
    /** boxd's bot protection answers non-browser clients, such as the phone app, with a challenge. */
    disableBotProtection: (vmId: string) =>
      call("SetBotProtection", encode(message([1, vmId], [2, false], [3, "off"]))).pipe(
        Effect.asVoid,
      ),
    setAutoHibernate: (vmId: string, seconds: number) =>
      call("SetAutoHibernateTimeout", encode(message([1, vmId], [2, seconds]))).pipe(Effect.asVoid),
    hibernate: (vmId: string) =>
      call("HibernateVm", encode(message([1, vmId]))).pipe(Effect.asVoid),
    createSnapshot: (vmId: string, name: string) =>
      call("CreateSnapshot", encode(message([1, vmId], [2, name])), Duration.minutes(2)).pipe(
        Effect.asVoid,
      ),
    getSnapshot: (name: string) =>
      orNull(
        call("GetSnapshot", encode(message([1, name]))).pipe(
          Effect.map((messages) => {
            const snapshot = first(messages).message(1);
            return snapshot === null ? null : snapshotOf(snapshot);
          }),
        ),
      ).pipe(Effect.map((snapshot) => snapshot ?? null)),
    listSnapshots: () =>
      call("ListSnapshots", encode(message())).pipe(
        Effect.map((messages) => first(messages).messages(1).map(snapshotOf)),
      ),
    deleteSnapshot: (name: string) =>
      orNull(call("DeleteSnapshot", encode(message([1, name])))).pipe(Effect.asVoid),
  };
}

export type BoxdApi = ReturnType<typeof makeBoxdApi>;
