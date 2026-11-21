import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
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
import { makeAntigravityUsageProbe } from "../../provider/antigravityUsageLimits.ts";
import type { AntigravityExecutable } from "../../provider/AntigravityInstallation.ts";

/**
 * Which runtime runs and where it keeps its sessions and its login. `managed` is T3's own `agy`,
 * which uses the profile T3 gives it. `cli` is a user's own `agy`, which uses the user's folder.
 */
export interface AntigravityRuntimeState {
  readonly runtime: "managed" | "cli";
  readonly root: string;
  readonly appFolder: string;
  readonly tokenFile: string;
}

export const profileAntigravityRuntimeState = (
  profileDirectory: string,
): AntigravityRuntimeState => ({
  runtime: "managed",
  root: profileDirectory,
  appFolder: "antigravity-acp",
  tokenFile: "acp_token.json",
});

/** An `agy` outside T3's managed releases; a managed release keeps its state in the profile. */
const isUserAgy = (executable: Pick<AntigravityExecutable, "managedVersionDirectory">) =>
  executable.managedVersionDirectory === null;

export function antigravityRuntimeState(
  executable: Pick<AntigravityExecutable, "managedVersionDirectory">,
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
    : profileAntigravityRuntimeState(input.profileDirectory);
}

const PROFILE_FLAGS = new Set(["--gemini-dir", "--app-data-dir"]);

/**
 * Upstream points every `agy` at T3's profile, and marks a Google sign-in as an SSH session so the
 * CLI keeps it in that profile; the user's own `agy` keeps its own login, keyring and state.
 */
export const withUserAgyState = (
  executable: Pick<AntigravityExecutable, "managedVersionDirectory">,
  spawn: AcpSessionRuntime.AcpSpawnInput,
  baseEnv: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput => {
  if (!isUserAgy(executable)) return spawn;
  const { SSH_CONNECTION: _profileSsh, ...env } = spawn.env ?? {};
  return {
    ...spawn,
    args: spawn.args.filter(
      (arg, index) => !PROFILE_FLAGS.has(arg) && !PROFILE_FLAGS.has(spawn.args[index - 1] ?? ""),
    ),
    ...(spawn.env === undefined
      ? {}
      : {
          env:
            baseEnv.SSH_CONNECTION === undefined
              ? env
              : { ...env, SSH_CONNECTION: baseEnv.SSH_CONNECTION },
        }),
  };
};

/** The state a caller was given, or the managed profile's when it was given none. */
export const antigravityRuntimeStateOf = (options: {
  readonly profileDirectory: string;
  readonly runtimeState?: Effect.Effect<AntigravityRuntimeState> | undefined;
}) =>
  options.runtimeState ?? Effect.succeed(profileAntigravityRuntimeState(options.profileDirectory));

const antigravityTokenPath = (state: AntigravityRuntimeState, path: Path.Path) =>
  path.join(state.root, state.appFolder, state.tokenFile);

/**
 * Limits read with the sign-in of whichever runtime runs when they are read. The runtime is
 * resolved per read, as the binary path may resolve only later; each runtime's folder is fixed.
 */
export const makeAntigravityRuntimeUsageProbe = Effect.fn("makeAntigravityRuntimeUsageProbe")(
  function* (
    input: Omit<Parameters<typeof makeAntigravityUsageProbe>[0], "appDirectory"> & {
      readonly userHome: string;
      readonly runtimeState: Effect.Effect<AntigravityRuntimeState>;
    },
  ) {
    const path = yield* Path.Path;
    const { userHome, runtimeState, ...options } = input;
    const cliState = antigravityRuntimeState(
      { managedVersionDirectory: null },
      { profileDirectory: options.profileDirectory, userHome, path },
    );
    const managed = yield* makeAntigravityUsageProbe(options);
    const cli = yield* makeAntigravityUsageProbe({
      ...options,
      appDirectory: path.join(cliState.root, cliState.appFolder),
    });
    return {
      probe: Effect.flatMap(runtimeState, (state) =>
        state.runtime === "cli" ? cli.probe : managed.probe,
      ),
      clear: Effect.andThen(managed.clear, cli.clear),
    };
  },
);

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
