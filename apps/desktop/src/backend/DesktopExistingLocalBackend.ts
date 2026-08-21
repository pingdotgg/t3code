import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const PAIRING_TTL = "1h";
const PAIRING_LABEL = "T3 Code Desktop";
const SYSTEMD_USER_UNIT = "t3code.service";

const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

const IssuedPairingCredential = Schema.Struct({
  credential: Schema.NonEmptyString,
});

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);
const decodeIssuedPairingCredential = Schema.decodeUnknownEffect(
  Schema.fromJsonString(IssuedPairingCredential),
);

export interface ExistingLocalBackend {
  readonly baseDir: string;
  readonly origin: string;
  readonly port: number;
  readonly pid: number;
  readonly environmentId: string | null;
  readonly label: string | null;
}

export class ExistingLocalBackendMintError extends Schema.TaggedErrorClass<ExistingLocalBackendMintError>()(
  "ExistingLocalBackendMintError",
  {
    baseDir: Schema.String,
    origin: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Could not mint a pairing token for the running T3 Code server at ${this.origin}: ${this.detail}`;
  }
}

const concatUint8Arrays = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  let totalLength = 0;
  for (const chunk of chunks) totalLength += chunk.byteLength;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);

// signal 0 delivers nothing; it only reports whether the pid exists. EPERM
// means it exists but belongs to another user, which still counts as alive.
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/**
 * Pull T3CODE_HOME out of a systemd unit or drop-in snippet. Handles the
 * common `Environment=T3CODE_HOME=/path` form, quoted values, and multiple
 * assignments on one line.
 */
const extractT3HomeAssignment = (
  envValue: string,
  options?: { readonly remainderIsValue?: boolean },
): string | null => {
  const marker = "T3CODE_HOME=";
  const index = envValue.indexOf(marker);
  if (index === -1) return null;
  const rest = envValue.slice(index + marker.length);
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    return end === -1 ? rest.slice(1) : rest.slice(1, end);
  }
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    return end === -1 ? rest.slice(1) : rest.slice(1, end);
  }
  if (options?.remainderIsValue === true) {
    return rest.length > 0 ? rest : null;
  }
  const space = rest.search(/\s/);
  const home = space === -1 ? rest : rest.slice(0, space);
  return home.length > 0 ? home : null;
};

export const parseSystemdT3Home = (unitText: string): string | null => {
  for (const rawLine of unitText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("Environment=")) continue;
    const raw = line.slice("Environment=".length);
    const quotedWhole =
      (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
      (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2);
    const home = extractT3HomeAssignment(quotedWhole ? raw.slice(1, -1) : raw, {
      remainderIsValue: quotedWhole,
    });
    if (home !== null && home.length > 0) return home;
  }
  return null;
};

const uniqueDirs = (dirs: ReadonlyArray<string>): Array<string> => {
  const seen = new Set<string>();
  const result: Array<string> = [];
  for (const dir of dirs) {
    const trimmed = dir.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

export const collectSeedBaseDirs = (input: {
  readonly homeDirectory: string;
  readonly desktopBaseDir: string;
  readonly systemdT3Home: string | null;
}): Array<string> =>
  uniqueDirs([
    input.desktopBaseDir,
    `${input.homeDirectory.replace(/\/+$/, "")}/.t3`,
    ...(input.systemdT3Home === null ? [] : [input.systemdT3Home]),
  ]);

const readOptionalFile = (fileSystem: FileSystem.FileSystem, path: string) =>
  fileSystem.readFileString(path).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.succeed(Option.none<string>()),
      onSuccess: (contents) => Effect.succeed(Option.some(contents)),
    }),
  );

const readSystemdT3Home = Effect.fn("desktop.existingLocalBackend.readSystemdT3Home")(function* (
  homeDirectory: string,
  path: Path.Path,
  fileSystem: FileSystem.FileSystem,
) {
  const unitDir = path.join(homeDirectory, ".config", "systemd", "user");
  const unitFile = path.join(unitDir, SYSTEMD_USER_UNIT);
  const dropInDir = path.join(unitDir, `${SYSTEMD_USER_UNIT}.d`);
  const pieces: Array<string> = [];
  const unitText = yield* readOptionalFile(fileSystem, unitFile);
  if (Option.isSome(unitText)) pieces.push(unitText.value);
  const dropInNames = yield* fileSystem
    .readDirectory(dropInDir)
    .pipe(Effect.orElseSucceed(() => []));
  for (const name of dropInNames) {
    if (!name.endsWith(".conf")) continue;
    const dropInText = yield* readOptionalFile(fileSystem, path.join(dropInDir, name));
    if (Option.isSome(dropInText)) pieces.push(dropInText.value);
  }
  return parseSystemdT3Home(pieces.join("\n"));
});

const probeExistingBackend = (
  origin: string,
  client: HttpClient.HttpClient,
): Effect.Effect<Option.Option<ExecutionEnvironmentDescriptor>> => {
  const url = new URL(WELL_KNOWN_ENVIRONMENT_PATH, origin.endsWith("/") ? origin : `${origin}/`);
  return client.execute(HttpClientRequest.get(url.toString())).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
    Effect.timeout(Duration.millis(1_500)),
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<ExecutionEnvironmentDescriptor>()),
  );
};

const readRuntimeState = (fileSystem: FileSystem.FileSystem, statePath: string) =>
  Effect.gen(function* () {
    const raw = yield* readOptionalFile(fileSystem, statePath);
    if (Option.isNone(raw)) return Option.none<PersistedServerRuntimeState>();
    const trimmed = raw.value.trim();
    if (trimmed.length === 0) return Option.none<PersistedServerRuntimeState>();
    return yield* decodePersistedServerRuntimeState(trimmed).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<PersistedServerRuntimeState>()),
    );
  });

const inspectBaseDir = Effect.fn("desktop.existingLocalBackend.inspectBaseDir")(function* (input: {
  readonly baseDir: string;
  readonly path: Path.Path;
  readonly fileSystem: FileSystem.FileSystem;
  readonly httpClient: HttpClient.HttpClient;
}) {
  const statePath = input.path.join(input.baseDir, "userdata", "server-runtime.json");
  const state = yield* readRuntimeState(input.fileSystem, statePath);
  if (Option.isNone(state)) return Option.none<ExistingLocalBackend>();
  if (!isProcessAlive(state.value.pid)) return Option.none<ExistingLocalBackend>();
  const descriptor = yield* probeExistingBackend(state.value.origin, input.httpClient);
  if (Option.isNone(descriptor)) return Option.none<ExistingLocalBackend>();
  return Option.some({
    baseDir: input.baseDir,
    origin: state.value.origin,
    port: state.value.port,
    pid: state.value.pid,
    environmentId: descriptor.value.environmentId,
    label: descriptor.value.label,
  } satisfies ExistingLocalBackend);
});

export const discoverExistingLocalBackend = Effect.fn("desktop.existingLocalBackend.discover")(
  function* (input: {
    readonly homeDirectory: string;
    readonly desktopBaseDir: string;
    readonly path: Path.Path;
    readonly fileSystem: FileSystem.FileSystem;
    readonly httpClient: HttpClient.HttpClient;
  }) {
    const systemdT3Home = yield* readSystemdT3Home(
      input.homeDirectory,
      input.path,
      input.fileSystem,
    );
    const seedDirs = collectSeedBaseDirs({
      homeDirectory: input.homeDirectory,
      desktopBaseDir: input.desktopBaseDir,
      systemdT3Home,
    });
    const defaultHome = input.path.join(input.homeDirectory, ".t3");
    const childNames = yield* input.fileSystem
      .readDirectory(defaultHome)
      .pipe(Effect.orElseSucceed(() => []));
    const candidates = uniqueDirs([
      ...seedDirs,
      ...childNames.map((name) => input.path.join(defaultHome, name)),
    ]);

    for (const baseDir of candidates) {
      const found = yield* inspectBaseDir({
        baseDir,
        path: input.path,
        fileSystem: input.fileSystem,
        httpClient: input.httpClient,
      });
      if (Option.isSome(found)) return found;
    }
    return Option.none<ExistingLocalBackend>();
  },
);

export type PairingProcessSpawn = (
  command: ReturnType<typeof ChildProcess.make>,
) => Effect.Effect<
  ChildProcessSpawner.ChildProcessHandle,
  import("effect/PlatformError").PlatformError,
  import("effect/Scope").Scope
>;

export const mintExistingLocalBackendCredential = Effect.fn(
  "desktop.existingLocalBackend.mintCredential",
)(function* (input: {
  readonly backend: ExistingLocalBackend;
  readonly executablePath: string;
  readonly entryPath: string;
  readonly spawn: PairingProcessSpawn;
}) {
  const command = ChildProcess.make(
    input.executablePath,
    [
      input.entryPath,
      "auth",
      "pairing",
      "create",
      "--base-dir",
      input.backend.baseDir,
      "--ttl",
      PAIRING_TTL,
      "--label",
      PAIRING_LABEL,
      "--json",
    ],
    {
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_HOME: input.backend.baseDir,
      },
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: Duration.seconds(15),
    },
  );

  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* input.spawn(command);
      const [stdoutBytes, stderrBytes, exitCode] = yield* Effect.all(
        [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: Number(exitCode),
        stdout: decodeUtf8(concatUint8Arrays([...stdoutBytes] as Uint8Array[])),
        stderr: decodeUtf8(concatUint8Arrays([...stderrBytes] as Uint8Array[])),
      };
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ExistingLocalBackendMintError({
          baseDir: input.backend.baseDir,
          origin: input.backend.origin,
          detail: cause instanceof Error ? cause.message : "Failed to spawn pairing CLI.",
        }),
    ),
  );

  if (result.exitCode !== 0) {
    return yield* new ExistingLocalBackendMintError({
      baseDir: input.backend.baseDir,
      origin: input.backend.origin,
      detail: result.stderr.trim() || `pairing CLI exited ${String(result.exitCode)}`,
    });
  }

  const issued = yield* decodeIssuedPairingCredential(result.stdout.trim()).pipe(
    Effect.mapError(
      (cause) =>
        new ExistingLocalBackendMintError({
          baseDir: input.backend.baseDir,
          origin: input.backend.origin,
          detail: cause instanceof Error ? cause.message : "pairing CLI returned invalid JSON.",
        }),
    ),
  );
  return issued.credential;
});
