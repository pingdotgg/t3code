import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { ExecutionEnvironmentDescriptor, PortSchema, PositiveInt } from "@t3tools/contracts";
import {
  BOOT_SERVICE_PLIST_FILE,
  BOOT_SERVICE_UNIT_FILE,
} from "@t3tools/shared/bootServiceIdentity";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";

const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: PositiveInt,
  host: Schema.optional(Schema.String),
  port: PortSchema,
  origin: Schema.URLFromString,
  devUrl: Schema.optional(Schema.URLFromString),
  desktopAttachToken: Schema.optional(Schema.NonEmptyString),
  startedAt: Schema.String,
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

export interface ExistingLocalBackend {
  readonly baseDir: string;
  readonly origin: string;
  readonly port: number;
  readonly pid: number;
  readonly environmentId: string | null;
  readonly label: string | null;
  readonly desktopAttachToken: string | null;
}

export interface ExistingLocalBackendAttachment {
  readonly backend: ExistingLocalBackend;
  readonly credential: string;
  readonly bearerToken: string;
}

const ExistingLocalBackendPairingReason = Schema.Literals([
  "missing-credential",
  "token-exchange-rejected",
  "server-unavailable",
]);

const pairingReasonMessage = {
  "missing-credential":
    "The running server does not advertise Desktop attachment credentials. Update and restart that server, then try again.",
  "token-exchange-rejected":
    "The server rejected or could not complete the Desktop session exchange.",
  "server-unavailable": "The previously attached server is no longer available.",
} as const;

export class ExistingLocalBackendPairingError extends Schema.TaggedErrorClass<ExistingLocalBackendPairingError>()(
  "ExistingLocalBackendPairingError",
  {
    baseDir: Schema.String,
    origin: Schema.String,
    reason: ExistingLocalBackendPairingReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not establish a secure Desktop session with the running T3 Code server at ${this.origin}: ${pairingReasonMessage[this.reason]}`;
  }
}

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
    let value = "";
    for (let index = 1; index < rest.length; index += 1) {
      const character = rest[index];
      if (character === '"') return value.replaceAll("%%", "%");
      if (character === "\\" && index + 1 < rest.length) {
        const escaped = rest[index + 1];
        if (escaped === "\\" || escaped === '"') {
          value += escaped;
          index += 1;
          continue;
        }
      }
      value += character;
    }
    return value.replaceAll("%%", "%");
  }
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    const value = end === -1 ? rest.slice(1) : rest.slice(1, end);
    return value.replaceAll("%%", "%");
  }
  if (options?.remainderIsValue === true) {
    return rest.length > 0 ? rest.replaceAll("%%", "%") : null;
  }
  const space = rest.search(/\s/);
  const home = space === -1 ? rest : rest.slice(0, space);
  return home.length > 0 ? home.replaceAll("%%", "%") : null;
};

export const parseSystemdT3Home = (unitText: string): string | null => {
  let resolvedHome: string | null = null;
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
    if (home !== null && home.length > 0) resolvedHome = home;
  }
  return resolvedHome;
};

const decodeXmlText = (value: string): string =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

/** Read T3CODE_HOME from the launchd plist emitted by `t3 service install`. */
export const parseLaunchdT3Home = (plistText: string): string | null => {
  const environmentVariables =
    /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plistText)?.[1];
  if (environmentVariables === undefined) return null;
  const encodedHome = /<key>\s*T3CODE_HOME\s*<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(
    environmentVariables,
  )?.[1];
  if (encodedHome === undefined) return null;
  const home = decodeXmlText(encodedHome.trim());
  return home.length > 0 ? home : null;
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
  readonly defaultBaseDir: string;
  readonly desktopBaseDir: string;
  readonly serviceT3Home: string | null;
}): Array<string> =>
  uniqueDirs([
    ...(input.serviceT3Home === null ? [] : [input.serviceT3Home]),
    input.defaultBaseDir,
    input.desktopBaseDir,
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
  const unitFile = path.join(unitDir, BOOT_SERVICE_UNIT_FILE);
  const dropInDir = path.join(unitDir, `${BOOT_SERVICE_UNIT_FILE}.d`);
  const pieces: Array<string> = [];
  const unitText = yield* readOptionalFile(fileSystem, unitFile);
  if (Option.isSome(unitText)) pieces.push(unitText.value);
  const dropInNames = yield* fileSystem
    .readDirectory(dropInDir)
    .pipe(Effect.orElseSucceed(() => []));
  for (const name of dropInNames.toSorted()) {
    if (!name.endsWith(".conf")) continue;
    const dropInText = yield* readOptionalFile(fileSystem, path.join(dropInDir, name));
    if (Option.isSome(dropInText)) pieces.push(dropInText.value);
  }
  return parseSystemdT3Home(pieces.join("\n"));
});

const readLaunchdT3Home = Effect.fn("desktop.existingLocalBackend.readLaunchdT3Home")(function* (
  homeDirectory: string,
  path: Path.Path,
  fileSystem: FileSystem.FileSystem,
) {
  const plistPath = path.join(homeDirectory, "Library", "LaunchAgents", BOOT_SERVICE_PLIST_FILE);
  const plistText = yield* readOptionalFile(fileSystem, plistPath);
  return Option.match(plistText, {
    onNone: () => null,
    onSome: parseLaunchdT3Home,
  });
});

const readServiceT3Home = Effect.fn("desktop.existingLocalBackend.readServiceT3Home")(function* (
  platform: NodeJS.Platform,
  homeDirectory: string,
  path: Path.Path,
  fileSystem: FileSystem.FileSystem,
) {
  if (platform === "linux") {
    return yield* readSystemdT3Home(homeDirectory, path, fileSystem);
  }
  if (platform === "darwin") {
    return yield* readLaunchdT3Home(homeDirectory, path, fileSystem);
  }
  return null;
});

const probeExistingBackend = (
  origin: URL,
  client: HttpClient.HttpClient,
): Effect.Effect<Option.Option<ExecutionEnvironmentDescriptor>> => {
  const url = new URL(WELL_KNOWN_ENVIRONMENT_PATH, origin);
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
    origin: state.value.origin.href,
    port: state.value.port,
    pid: state.value.pid,
    environmentId: descriptor.value.environmentId,
    label: descriptor.value.label,
    desktopAttachToken: state.value.desktopAttachToken ?? null,
  } satisfies ExistingLocalBackend);
});

export const discoverExistingLocalBackend = Effect.fn("desktop.existingLocalBackend.discover")(
  function* (input: {
    readonly homeDirectory: string;
    readonly desktopBaseDir: string;
    readonly platform: NodeJS.Platform;
    readonly path: Path.Path;
    readonly fileSystem: FileSystem.FileSystem;
    readonly httpClient: HttpClient.HttpClient;
  }) {
    const serviceT3Home = yield* readServiceT3Home(
      input.platform,
      input.homeDirectory,
      input.path,
      input.fileSystem,
    );
    const seedDirs = collectSeedBaseDirs({
      defaultBaseDir: input.path.join(input.homeDirectory, ".t3"),
      desktopBaseDir: input.desktopBaseDir,
      serviceT3Home,
    });

    for (const baseDir of seedDirs) {
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

export const pairExistingLocalBackend = Effect.fn("desktop.existingLocalBackend.pair")(
  function* (input: {
    readonly backend: ExistingLocalBackend;
    readonly httpClient: HttpClient.HttpClient;
  }) {
    const credential = input.backend.desktopAttachToken;
    if (credential === null) {
      return yield* new ExistingLocalBackendPairingError({
        baseDir: input.backend.baseDir,
        origin: input.backend.origin,
        reason: "missing-credential",
      });
    }

    const session = yield* bootstrapRemoteBearerSession({
      httpBaseUrl: input.backend.origin,
      credential,
      clientMetadata: {
        label: "T3 Code Desktop",
        deviceType: "desktop",
      },
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, input.httpClient),
      Effect.mapError(
        (cause) =>
          new ExistingLocalBackendPairingError({
            baseDir: input.backend.baseDir,
            origin: input.backend.origin,
            reason: "token-exchange-rejected",
            cause,
          }),
      ),
    );
    return {
      backend: input.backend,
      credential,
      bearerToken: session.access_token,
    } satisfies ExistingLocalBackendAttachment;
  },
);
