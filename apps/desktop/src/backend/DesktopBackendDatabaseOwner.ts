import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const SERVER_RUNTIME_STATE_FILE_NAME = "server-runtime.json";
const SERVER_PROBE_TIMEOUT = Duration.seconds(2);
const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";

const PersistedServerRuntimeOwner = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  origin: Schema.String,
});
type PersistedServerRuntimeOwner = typeof PersistedServerRuntimeOwner.Type;

const decodePersistedServerRuntimeOwner = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeOwner),
);

export class DesktopBackendDatabaseOwnedError extends Schema.TaggedErrorClass<DesktopBackendDatabaseOwnedError>()(
  "DesktopBackendDatabaseOwnedError",
  {
    stateDir: Schema.String,
    origin: Schema.String,
    pid: Schema.Int,
  },
) {
  override get message(): string {
    return [
      `A running T3 Code server at ${this.origin} (PID ${String(this.pid)}) already uses ${this.stateDir}.`,
      "Starting another backend with the same database is unsafe.",
      "Stop the background service before opening the desktop app, or start the desktop app with a separate T3CODE_HOME and connect to the running environment.",
    ].join("\n");
  }
}

const readRuntimeOwner = (
  statePath: string,
): Effect.Effect<Option.Option<PersistedServerRuntimeOwner>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const raw = yield* fileSystem.readFileString(statePath).pipe(Effect.option);
    if (Option.isNone(raw) || raw.value.trim().length === 0) {
      return Option.none();
    }
    return yield* decodePersistedServerRuntimeOwner(raw.value.trim()).pipe(Effect.option);
  });

const defaultIsProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const probeT3Server = (origin: string): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const endpoint = yield* Effect.try(() =>
      new URL(WELL_KNOWN_ENVIRONMENT_PATH, origin).toString(),
    );
    const request = HttpClientRequest.get(endpoint);
    yield* httpClient
      .execute(request)
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
        Effect.timeout(SERVER_PROBE_TIMEOUT),
      );
    return true;
  }).pipe(Effect.orElseSucceed(() => false));

export const ensureDesktopBackendDatabaseAvailable = Effect.fn(
  "desktop.backendDatabaseOwner.ensureAvailable",
)(function* (input: {
  readonly stateDir: string;
  readonly joinPath: (...parts: ReadonlyArray<string>) => string;
  readonly isProcessAlive?: (pid: number) => boolean;
}) {
  const statePath = input.joinPath(input.stateDir, SERVER_RUNTIME_STATE_FILE_NAME);
  const runtimeOwner = yield* readRuntimeOwner(statePath);
  if (Option.isNone(runtimeOwner)) {
    return;
  }

  const owner = runtimeOwner.value;
  if (!(input.isProcessAlive ?? defaultIsProcessAlive)(owner.pid)) {
    return;
  }

  if (!(yield* probeT3Server(owner.origin))) {
    return;
  }

  return yield* new DesktopBackendDatabaseOwnedError({
    stateDir: input.stateDir,
    origin: owner.origin,
    pid: owner.pid,
  });
});
