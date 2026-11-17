import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import type { BoatCloudEnvironment } from "@t3tools/contracts";

/**
 * A thin client for the parts of the Boat v1 API that Boat cloud uses. It runs
 * on the server and on the phone, so it needs only an HTTP client.
 */

const BOAT_API_URL = "https://boat.dev/api/v1";

export class BoatApiError extends Schema.TaggedError<BoatApiError>()("BoatApiError", {
  status: Schema.Number,
  code: Schema.String,
  /** Fixed or built from `code` and `status`; Boat's own text and VM output stay in `cause`. */
  message: Schema.String,
  retryable: Schema.Boolean,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const BoatSandbox = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.String,
  /** Stable across stop and resume; hosted ports live at `<subdomain>-<port>.on.boat.dev`. */
  subdomain: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  /** The environment's name. A sandbox keeps it for life; null for one attached to none. */
  environment: Schema.optional(Schema.NullOr(Schema.String)),
});
export type BoatSandbox = typeof BoatSandbox.Type;

const BoatEnvironment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  isDefault: Schema.Boolean,
  passGithub: Schema.Boolean,
  passSandboxCredentials: Schema.Boolean,
  passSecrets: Schema.Boolean,
  passAgentsCredentials: Schema.Boolean,
  /** An id or a name; null means the account's default profile. */
  credentialProfileId: Schema.optional(Schema.NullOr(Schema.String)),
});
export type BoatEnvironment = typeof BoatEnvironment.Type;
const EnvironmentList = Schema.Struct({ environments: Schema.Array(BoatEnvironment) });

const BoatCredentialProfile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  isDefault: Schema.Boolean,
  /** The ids of the credentials it holds, never their values. */
  connected: Schema.Array(Schema.String),
});
export type BoatCredentialProfile = typeof BoatCredentialProfile.Type;
const CredentialProfileList = Schema.Struct({ profiles: Schema.Array(BoatCredentialProfile) });

/**
 * What a client shows of each environment, with the AI credentials its VMs get:
 * those of its profile, or none when it passes no agent credentials.
 */
export function cloudEnvironments(
  environments: ReadonlyArray<BoatEnvironment>,
  profiles: ReadonlyArray<BoatCredentialProfile> | null,
): Array<BoatCloudEnvironment> {
  return environments.map((environment) => {
    const named = environment.credentialProfileId ?? null;
    const profile = profiles?.find((candidate) =>
      named === null ? candidate.isDefault : candidate.id === named || candidate.name === named,
    );
    return {
      id: environment.id,
      name: environment.name,
      isDefault: environment.isDefault,
      passGithub: environment.passGithub,
      passSandboxCredentials: environment.passSandboxCredentials,
      passSecrets: environment.passSecrets,
      passAgentsCredentials: environment.passAgentsCredentials,
      agentCredentials: !environment.passAgentsCredentials ? [] : (profile?.connected ?? null),
    };
  });
}

export type BoatMachineType = "small" | "default" | "large" | "xlarge";

const ErrorBody = Schema.Struct({
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      details: Schema.optional(
        Schema.Struct({
          retryable: Schema.optional(Schema.Boolean),
          message: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

const Me = Schema.Struct({
  user: Schema.Struct({
    login: Schema.optional(Schema.String),
    email: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const SandboxResponse = Schema.Struct({ sandbox: BoatSandbox });
const SandboxList = Schema.Struct({ sandboxes: Schema.Array(BoatSandbox) });
const CommandResult = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  timedOut: Schema.optional(Schema.Boolean),
});
export type BoatCommandResult = typeof CommandResult.Type;
const FileUrl = Schema.Struct({ url: Schema.String });
const HostResponse = Schema.Struct({ url: Schema.String });
const SavedSnapshot = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  /** The VM it was saved from. A save under the same name replaces it. */
  sourceSandboxId: Schema.optional(Schema.NullOr(Schema.String)),
  /** When the name was first saved; a later save under it keeps this. */
  createdAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export type BoatSnapshot = typeof SavedSnapshot.Type;
const SavedSnapshotList = Schema.Struct({ snapshots: Schema.Array(SavedSnapshot) });

// Commands right after a create or resume can land while the VM mounts its files.
const transientRetry = Schedule.spaced(Duration.seconds(2));

export function makeBoatApi(http: HttpClient.HttpClient, apiKey: string) {
  const fail = (response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(
      Effect.orElseSucceed((): unknown => undefined),
      Effect.flatMap((json) => {
        const body = decodeErrorBody(json);
        const parsed = body._tag === "Some" ? body.value : undefined;
        const code = parsed?.code ?? `http_${response.status}`;
        const retryable =
          code === "sandbox_starting" ||
          code === "sandbox_resuming" ||
          parsed?.error?.details?.message === "sandbox_restoring" ||
          (code === "sandbox_direct_failed" && parsed?.error?.details?.retryable === true) ||
          response.status === 503;
        return Effect.fail(
          new BoatApiError({
            status: response.status,
            code,
            message:
              parsed?.code === undefined
                ? `Boat answered ${response.status}.`
                : `Boat answered ${response.status}: ${parsed.code}.`,
            retryable,
            cause: json,
          }),
        );
      }),
    );

  const send = <A, I>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I>,
    timeout: Duration.Input = Duration.seconds(30),
  ) =>
    http.execute(HttpClientRequest.bearerToken(request, apiKey)).pipe(
      Effect.mapError(
        (cause) =>
          new BoatApiError({
            status: 0,
            code: "network",
            message: "Could not reach Boat.",
            retryable: true,
            cause,
          }),
      ),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(schema)),
              Effect.mapError(
                (cause) =>
                  new BoatApiError({
                    status: response.status,
                    code: "invalid_response",
                    message: "Boat returned an unexpected response.",
                    retryable: false,
                    cause,
                  }),
              ),
            )
          : fail(response),
      ),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new BoatApiError({
              status: 0,
              code: "timeout",
              message: "Boat did not answer in time.",
              retryable: false,
            }),
          ),
      }),
    );
  const url = (path: string) => `${BOAT_API_URL}${path}`;
  const json = (method: "POST" | "PUT" | "PATCH", path: string, body: unknown) =>
    HttpClientRequest.make(method)(url(path)).pipe(HttpClientRequest.bodyJsonUnsafe(body));
  const retryTransient = <A, R>(
    effect: Effect.Effect<A, BoatApiError, R>,
    retryable = (error: BoatApiError) => error.retryable,
  ) => effect.pipe(Effect.retry({ schedule: transientRetry, times: 15, while: retryable }));
  const orNull = <A, R>(effect: Effect.Effect<A, BoatApiError, R>) =>
    effect.pipe(
      Effect.catchIf(
        (error) => error.status === 404,
        () => Effect.succeed(null),
      ),
    );

  return {
    me: () =>
      send(HttpClientRequest.get(url("/me")), Me).pipe(
        Effect.map((me) => me.user.email ?? me.user.login ?? "Boat account"),
      ),
    listSandboxes: (label: string) =>
      send(
        HttpClientRequest.get(url("/sandboxes")).pipe(
          HttpClientRequest.setUrlParam("label", label),
          HttpClientRequest.setUrlParam("limit", "200"),
        ),
        SandboxList,
      ).pipe(Effect.map((list) => list.sandboxes)),
    getSandbox: (id: string) =>
      orNull(
        send(HttpClientRequest.get(url(`/sandboxes/${id}`)), SandboxResponse).pipe(
          Effect.map((response) => response.sandbox),
        ),
      ),
    createSandbox: (body: {
      readonly name: string;
      readonly type?: BoatMachineType;
      readonly labels: Readonly<Record<string, string>>;
      readonly from?: string;
      /** Boat stops the VM this long after it starts unless something extends it. */
      readonly ttlSeconds: number;
      /** An environment name; Boat's default environment when absent. */
      readonly environment?: string;
    }) =>
      send(json("POST", "/sandboxes", body), SandboxResponse, Duration.minutes(5)).pipe(
        Effect.map((response) => response.sandbox),
      ),
    /** `type` resizes the VM as it starts; absent keeps its size. */
    resume: (id: string, ttlSeconds: number, type?: BoatMachineType) =>
      send(
        json(
          "POST",
          `/sandboxes/${id}/resume`,
          type === undefined ? { ttlSeconds } : { ttlSeconds, type },
        ),
        SandboxResponse,
        Duration.minutes(5),
      ),
    rename: (id: string, name: string) =>
      send(json("PATCH", `/sandboxes/${id}`, { name }), Schema.Unknown),
    /** Moves the auto-stop deadline to now plus `ttlSeconds`. */
    extend: (id: string, ttlSeconds: number) =>
      send(json("PATCH", `/sandboxes/${id}`, { ttlSeconds }), Schema.Unknown),
    stop: (id: string) => send(json("POST", `/sandboxes/${id}/stop`, {}), Schema.Unknown),
    delete: (id: string) =>
      orNull(
        send(
          HttpClientRequest.delete(url(`/sandboxes/${id}`)).pipe(
            HttpClientRequest.setHeader("X-Ascii-Confirm-Delete", id),
          ),
          Schema.Unknown,
        ),
      ),
    exec: (id: string, command: string, timeoutSeconds = 60) =>
      retryTransient(
        send(
          json("POST", `/sandboxes/${id}/commands`, { command, timeoutSeconds }),
          CommandResult,
          Duration.seconds(timeoutSeconds + 30),
        ),
        // A dropped connection may follow a command Boat already ran, and commands are not idempotent.
        (error) => error.retryable && error.code !== "network",
      ),
    writeFile: (id: string, path: string, content: string) =>
      retryTransient(
        send(json("PUT", `/sandboxes/${id}/files`, { path, content }), Schema.Unknown),
      ),
    host: (id: string, port: number) =>
      send(
        json("POST", `/sandboxes/${id}/host`, { port, public: true, localhost: true }),
        HostResponse,
      ).pipe(Effect.map((response) => response.url)),
    /** A signed URL that takes a PUT of the file's bytes, with no size limit. */
    uploadUrl: (id: string, path: string) =>
      retryTransient(
        send(json("POST", `/sandboxes/${id}/files/upload-url`, { path }), FileUrl),
      ).pipe(Effect.map((response) => response.url)),
    /** A signed URL that serves the file with a GET. */
    downloadUrl: (id: string, path: string) =>
      retryTransient(
        send(json("POST", `/sandboxes/${id}/files/download-url`, { path }), FileUrl),
      ).pipe(Effect.map((response) => response.url)),
    saveSnapshot: (sandboxId: string, name: string) =>
      send(json("POST", "/saved-snapshots", { sandboxId, name }), Schema.Unknown),
    listSnapshots: () =>
      send(HttpClientRequest.get(url("/saved-snapshots")), SavedSnapshotList).pipe(
        Effect.map((list) => list.snapshots),
      ),
    deleteSnapshot: (name: string) =>
      orNull(
        send(
          HttpClientRequest.delete(url(`/saved-snapshots/${name}`)).pipe(
            HttpClientRequest.setHeader("X-Ascii-Confirm-Delete", name),
          ),
          Schema.Unknown,
        ),
      ),
    listEnvironments: () =>
      send(HttpClientRequest.get(url("/environments")), EnvironmentList).pipe(
        Effect.map((list) => list.environments),
      ),
    listCredentialProfiles: () =>
      send(HttpClientRequest.get(url("/credential-profiles")), CredentialProfileList).pipe(
        Effect.map((list) => list.profiles),
      ),
    /** A change makes a new environment version, which only VMs started after it get. */
    updateEnvironment: (
      id: string,
      body: Partial<
        Pick<
          BoatEnvironment,
          "passGithub" | "passSandboxCredentials" | "passSecrets" | "passAgentsCredentials"
        >
      >,
    ) => send(json("PUT", `/environments/${id}`, body), Schema.Unknown),
    /** For a response from a signed URL, in Boat's error shape. */
    fail,
  };
}
export type BoatApi = ReturnType<typeof makeBoatApi>;
