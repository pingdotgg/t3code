import { Effect, Exit, FileSystem, Option, Schema } from "effect";
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
  devUrl: Schema.optional(Schema.String),
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
  readonly config: Pick<ServerConfigShape, "host" | "devUrl">;
  readonly port: number;
}): PersistedServerRuntimeState => ({
  version: 1,
  pid: process.pid,
  ...(input.config.host ? { host: input.config.host } : {}),
  port: input.port,
  origin: runtimeOriginForConfig(input.config, input.port),
  ...(input.config.devUrl ? { devUrl: input.config.devUrl.toString() } : {}),
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

export type PersistedServerRuntimeStateInspection =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Invalid"; readonly cause: unknown }
  | { readonly _tag: "Found"; readonly state: PersistedServerRuntimeState };

export const inspectPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* Effect.exit(fs.exists(path));
    if (Exit.isFailure(exists)) {
      return { _tag: "Invalid", cause: exists.cause } as const;
    }
    if (!exists.value) {
      return { _tag: "Missing" } as const;
    }

    const raw = yield* Effect.exit(fs.readFileString(path));
    if (Exit.isFailure(raw)) {
      return { _tag: "Invalid", cause: raw.cause } as const;
    }
    const trimmed = raw.value.trim();
    if (trimmed.length === 0) {
      return { _tag: "Invalid", cause: new Error("Runtime state file is empty.") } as const;
    }

    const decoded = yield* Effect.exit(decodePersistedServerRuntimeState(trimmed));
    return Exit.isSuccess(decoded)
      ? ({ _tag: "Found", state: decoded.value } as const)
      : ({ _tag: "Invalid", cause: decoded.cause } as const);
  });

export const readPersistedServerRuntimeState = (path: string) =>
  inspectPersistedServerRuntimeState(path).pipe(
    Effect.map((result) =>
      result._tag === "Found"
        ? Option.some(result.state)
        : Option.none<PersistedServerRuntimeState>(),
    ),
  );

const fileErrorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

export const runtimePidIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) {
    return false;
  }
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
