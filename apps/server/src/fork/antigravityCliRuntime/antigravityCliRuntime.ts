import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { removeAntigravitySessionFiles } from "../../provider/acp/AntigravitySessionFiles.ts";
import type { AntigravityExecutable } from "../../provider/AntigravityInstallation.ts";

/**
 * Which runtime runs and where it keeps its sessions and its login. `harness` is the older 1.4.5
 * runtime and `managed` is T3's own `agy`; both use the profile T3 gives them. `cli` is a user's own
 * `agy`, which uses the user's folder.
 */
export interface AntigravityRuntimeState {
  readonly runtime: "harness" | "managed" | "cli";
  readonly root: string;
  readonly appFolder: string;
  readonly tokenFile: string;
}

export const profileAntigravityRuntimeState = (
  profileDirectory: string,
  runtime: "harness" | "managed" = "harness",
): AntigravityRuntimeState => ({
  runtime,
  root: profileDirectory,
  appFolder: "antigravity-acp",
  tokenFile: "acp_token.json",
});

/** An `agy` outside T3's managed releases; a managed release keeps its state in the profile. */
const isUserAgy = (
  executable: Pick<AntigravityExecutable, "harnessPath" | "managedVersionDirectory">,
) => executable.harnessPath === null && executable.managedVersionDirectory === null;

export function antigravityRuntimeState(
  executable: Pick<AntigravityExecutable, "harnessPath" | "managedVersionDirectory">,
  input: {
    readonly profileDirectory: string;
    readonly userHome: string;
    readonly path: Path.Path;
  },
): AntigravityRuntimeState {
  return isUserAgy(executable)
    ? {
        runtime: "cli",
        root: input.path.join(input.userHome, ".gemini"),
        appFolder: "antigravity-cli",
        tokenFile: "antigravity-oauth-token",
      }
    : profileAntigravityRuntimeState(
        input.profileDirectory,
        executable.harnessPath === null ? "managed" : "harness",
      );
}

const PROFILE_FLAGS = new Set(["--gemini-dir", "--app-data-dir"]);

/** Upstream points every `agy` at T3's profile; the user's own `agy` keeps its own login and state. */
export const withUserAgyState = (
  executable: Pick<AntigravityExecutable, "harnessPath" | "managedVersionDirectory">,
  spawn: AcpSessionRuntime.AcpSpawnInput,
): AcpSessionRuntime.AcpSpawnInput =>
  isUserAgy(executable)
    ? {
        ...spawn,
        args: spawn.args.filter(
          (arg, index) =>
            !PROFILE_FLAGS.has(arg) && !PROFILE_FLAGS.has(spawn.args[index - 1] ?? ""),
        ),
      }
    : spawn;

/** The state a caller was given, or the managed profile's when it was given none. */
export const antigravityRuntimeStateOf = (options: {
  readonly profileDirectory: string;
  readonly runtimeState?: Effect.Effect<AntigravityRuntimeState> | undefined;
}) =>
  options.runtimeState ?? Effect.succeed(profileAntigravityRuntimeState(options.profileDirectory));

export const antigravityTokenPath = (state: AntigravityRuntimeState, path: Path.Path) =>
  path.join(state.root, state.appFolder, state.tokenFile);

/** `agy` runs shell commands in an additional directory instead of the session's cwd. */
export const antigravitySessionDirectories = (
  state: AntigravityRuntimeState,
  attachmentsDir: string,
): ReadonlyArray<string> => (state.runtime === "harness" ? [attachmentsDir] : []);

/**
 * `agy acp` runs a `/compact` prompt as its own command. The older harness runtime reads it as
 * chat, so its sessions offer no compaction. The runtime is read as each session opens.
 */
export const withAntigravityCliCompaction =
  <Session extends { readonly compactThread?: unknown }, Input, E, R>(
    openSession: (input: Input) => Effect.Effect<Session, E, R>,
    options: Parameters<typeof antigravityRuntimeStateOf>[0],
  ) =>
  (input: Input): Effect.Effect<Session, E, R> =>
    Effect.zipWith(openSession(input), antigravityRuntimeStateOf(options), (session, state) => {
      if (state.runtime !== "harness") return session;
      const { compactThread: _, ...harness } = session;
      return harness as Session;
    });

const RefreshToken = Schema.Struct({ refresh_token: Schema.NonEmptyString });
const decodeRefreshToken = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([RefreshToken, Schema.Struct({ token: RefreshToken })])),
);

// A new process may rewrite project_id after onboarding; the refresh token alone names the login.
export const readAntigravityAccount = Effect.fn("AntigravityAdapterV2.readAccount")(function* (
  runtimeState: Effect.Effect<AntigravityRuntimeState>,
  services: {
    readonly digest: Digest.Digest["Service"];
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  },
) {
  const state = yield* runtimeState;
  const login = Option.flatMap(
    yield* services.fileSystem
      .readFileString(antigravityTokenPath(state, services.path))
      .pipe(Effect.option),
    decodeRefreshToken,
  );
  if (Option.isNone(login)) return Option.none<string>();
  const { refresh_token } = "token" in login.value ? login.value.token : login.value;
  const digest = yield* services.digest
    .digest(Digest.sha256, new TextEncoder().encode(refresh_token))
    .pipe(Effect.option);
  return Option.map(digest, Hex.encode);
});

// google.rpc.Code names. The CLI's error step is length-prefixed, so a length byte that may be
// a capital letter leads the status; only a known name finds where the status starts.
const CLI_API_ERROR =
  /(CANCELLED|UNKNOWN|INVALID_ARGUMENT|DEADLINE_EXCEEDED|NOT_FOUND|ALREADY_EXISTS|PERMISSION_DENIED|RESOURCE_EXHAUSTED|FAILED_PRECONDITION|ABORTED|OUT_OF_RANGE|UNIMPLEMENTED|INTERNAL|UNAVAILABLE|DATA_LOSS|UNAUTHENTICATED) \(code (\d{3})\): ([^\p{Cc}]+)/u;

/** The CLI's `STATUS (code NNN): message`, in the managed pattern's group order: code, message, status. */
export function antigravityCliApiError(text: string) {
  const match = CLI_API_ERROR.exec(text);
  return match === null ? null : ([match[0], match[2], match[3], match[1]] as const);
}

const CliLogin = Schema.Struct({
  token: Schema.Struct({
    access_token: Schema.NonEmptyString,
    refresh_token: Schema.NonEmptyString,
    expiry: Schema.NonEmptyString,
  }),
});
const decodeCliLogin = Schema.decodeEffect(Schema.fromJsonString(CliLogin));

interface AntigravityAccess {
  readonly access_token: string;
  readonly expires_in: number;
}

/**
 * Undefined unless the runtime is a user's own `agy`. The CLI's login holds no OAuth client, so T3 cannot
 * refresh it. The access token the CLI last saved stands in for a refresh until it expires.
 */
export const readAntigravityCliUsageLogin = Effect.fn("readAntigravityCliUsageLogin")(function* (
  state: AntigravityRuntimeState,
  text: string,
  checkedAt: string,
) {
  if (state.runtime !== "cli") return undefined;
  const { token } = yield* decodeCliLogin(text);
  const expiresIn = (Date.parse(token.expiry) - (yield* Clock.currentTimeMillis)) / 1000;
  const login: {
    readonly client_id: string;
    readonly client_secret: string;
    readonly refresh_token: string;
    readonly project_id?: string;
  } = { client_id: "", client_secret: "", refresh_token: token.refresh_token };
  const access: AntigravityAccess = { access_token: token.access_token, expires_in: expiresIn };
  return {
    token: login,
    access,
    unavailable:
      expiresIn > 60
        ? undefined
        : makeUnavailableUsageLimits({
            checkedAt,
            reason: "unsupported",
            message:
              "The Antigravity CLI's access has expired, and only the CLI can renew it. Limits show again after its next turn.",
          }),
  };
});

/** A CLI login's saved access replaces the refresh request, which is then never sent. */
export const orAntigravityCliAccess =
  (cli: { readonly access: AntigravityAccess } | undefined) =>
  <E, R>(refresh: Effect.Effect<AntigravityAccess, E, R>): Effect.Effect<AntigravityAccess, E, R> =>
    cli === undefined ? refresh : Effect.succeed(cli.access);

const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));

/** The length-delimited fields of one protobuf message, or none when the bytes are not one. */
function protobufFields(message: Uint8Array) {
  const fields: Array<{ readonly number: number; readonly bytes: Uint8Array }> = [];
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let scale = 1; scale < 2 ** 70; scale *= 128) {
      const byte = message[offset++];
      if (byte === undefined) return undefined;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
    }
    return undefined;
  };
  while (offset < message.length) {
    const tag = varint();
    if (tag === undefined) return [];
    const wireType = tag % 8;
    if (wireType === 1) offset += 8;
    else if (wireType === 5) offset += 4;
    else if (wireType === 0 || wireType === 2) {
      const value = varint();
      if (value === undefined) return [];
      if (wireType === 0) continue;
      fields.push({ number: Math.floor(tag / 8), bytes: message.subarray(offset, offset + value) });
      offset += value;
    } else return [];
  }
  return offset === message.length ? fields : [];
}

/**
 * The CLI's session log names its workspace as a `file://` URI in field 1 of field 1 of its
 * metadata. The log is read only as a regular file that no link stands in for.
 */
const cliSessionOpenedIn = Effect.fn("cliSessionOpenedIn")(function* (
  database: string,
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* fs.realPath(path.dirname(database));
  if ((yield* fs.realPath(database)) !== path.join(folder, path.basename(database))) return false;
  if ((yield* fs.stat(database)).type !== "File") return false;
  const uri = (yield* path.toFileUrl(cwd)).href;
  const rows = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      readonly data: unknown;
    }>`SELECT data FROM trajectory_metadata_blob WHERE id = 'main'`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database, readonly: true })));
  const metadata = rows[0]?.data;
  if (!(metadata instanceof Uint8Array)) return false;
  const workspaces = protobufFields(metadata)
    .filter((field) => field.number === 1)
    .flatMap((workspace) => protobufFields(workspace.bytes))
    .filter((field) => field.number === 1)
    .map((field) => new TextDecoder().decode(field.bytes));
  return workspaces.length === 1 && workspaces[0] === uri;
});

/**
 * Call after the process closes. The CLI keeps its sessions among the user's own, so only a
 * session whose log names the caller's unique temporary cwd is removed.
 */
export const removeAntigravityRuntimeSessionFiles = Effect.fn(
  "removeAntigravityRuntimeSessionFiles",
)(
  function* (input: {
    readonly runtimeState: Effect.Effect<AntigravityRuntimeState>;
    readonly sessionId: string | undefined;
    readonly cwd: string;
  }) {
    const state = yield* input.runtimeState;
    const { sessionId, cwd } = input;
    if (state.runtime !== "cli") {
      return yield* removeAntigravitySessionFiles({ profileDirectory: state.root, sessionId, cwd });
    }
    if (sessionId === undefined || !isNativeSessionId(sessionId)) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appDirectory = path.join(state.root, state.appFolder);
    const base = path.join(appDirectory, "conversations", sessionId);
    if (!(yield* cliSessionOpenedIn(`${base}.db`, cwd))) return;
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal"]) {
      yield* fs.remove(`${base}${suffix}`, { force: true });
    }
    yield* fs.remove(path.join(appDirectory, "annotations", `${sessionId}.pbtxt`), { force: true });
    yield* fs.remove(path.join(appDirectory, "brain", sessionId), { recursive: true, force: true });
  },
  Effect.catch(() => Effect.logWarning("Could not remove temporary Antigravity session files.")),
);
