import { Effect, FileSystem, Option, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm } from "node:fs/promises";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import { type ServerConfigShape } from "./config.ts";
import { formatHostForUrl, isWildcardHost } from "./startupAccess.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  startedAt: Schema.String,
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);
const decodePersistedServerRuntimeStatePromise = Schema.decodeUnknownPromise(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

const runtimeOriginForConfig = (
  config: Pick<ServerConfigShape, "host">,
  port: number,
): PersistedServerRuntimeState["origin"] => {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${port}`;
};

export const makePersistedServerRuntimeState = (input: {
  readonly config: Pick<ServerConfigShape, "host">;
  readonly port: number;
}): PersistedServerRuntimeState => ({
  version: 1,
  pid: process.pid,
  ...(input.config.host ? { host: input.config.host } : {}),
  port: input.port,
  origin: runtimeOriginForConfig(input.config, input.port),
  startedAt: new Date().toISOString(),
});

export const persistServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  writeFileStringAtomically({
    filePath: input.path,
    contents: `${JSON.stringify(input.state)}\n`,
  });

export const readPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return Option.none<PersistedServerRuntimeState>();
    }

    const raw = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return Option.none<PersistedServerRuntimeState>();
    }

    return yield* decodePersistedServerRuntimeState(trimmed).pipe(Effect.option);
  });

const fileErrorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const runtimePidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return fileErrorCode(cause) !== "ESRCH";
  }
};

export const clearPersistedServerRuntimeState = (path: string, expectedPid: number = process.pid) =>
  Effect.tryPromise(async () => {
    const claimedPath = `${path}.${expectedPid}.${randomUUID()}.clear`;
    try {
      await rename(path, claimedPath);
    } catch (cause) {
      if (fileErrorCode(cause) === "ENOENT") return false;
      throw cause;
    }

    const restoreClaim = async () => {
      try {
        await link(claimedPath, path);
      } catch (cause) {
        if (fileErrorCode(cause) !== "EEXIST") throw cause;
      }
      await rm(claimedPath, { force: true });
    };

    const state = await decodePersistedServerRuntimeStatePromise(
      await readFile(claimedPath, "utf8"),
    ).catch(() => undefined);
    if (state?.pid !== expectedPid) {
      if (state !== undefined && !runtimePidIsAlive(state.pid)) {
        await rm(claimedPath, { force: true });
        return false;
      }
      await restoreClaim();
      return false;
    }

    await rm(claimedPath, { force: true });
    return true;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to clear persisted server runtime state", {
        cause,
        path,
        expectedPid,
      }).pipe(Effect.as(false)),
    ),
  );
