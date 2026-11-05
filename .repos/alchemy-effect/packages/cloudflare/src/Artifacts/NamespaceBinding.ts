import * as Effect from "effect/Effect";
import type { Namespace } from "./Namespace.ts";
import {
  ArtifactsError,
  type ArtifactsErrorCode,
  type ReadWriteNamespaceClient,
  type RepoClient,
  type RepoHandle,
} from "./ReadWriteNamespace.ts";

/**
 * Shared scaffolding for the Worker-binding implementations of the Artifacts
 * services: maps the platform's thrown errors onto {@link ArtifactsError} and
 * wraps the runtime binding and its repo handles in Effect-native clients.
 */

const ARTIFACTS_ERROR_CODES: { readonly [K in ArtifactsErrorCode]: true } = {
  ALREADY_EXISTS: true,
  NOT_FOUND: true,
  CREATE_IN_PROGRESS: true,
  IMPORT_IN_PROGRESS: true,
  FORK_IN_PROGRESS: true,
  INVALID_INPUT: true,
  INVALID_REPO_NAME: true,
  INVALID_TTL: true,
  INVALID_URL: true,
  REMOTE_AUTH_REQUIRED: true,
  UPSTREAM_UNAVAILABLE: true,
  MEMORY_LIMIT: true,
  INTERNAL_ERROR: true,
};

const isArtifactsErrorCode = (code: unknown): code is ArtifactsErrorCode =>
  typeof code === "string" && Object.hasOwn(ARTIFACTS_ERROR_CODES, code);

/** The REST API's `errors[].code` for `NOT_FOUND`. */
const NOT_FOUND_NUMERIC_CODE = 10200;

/**
 * Map a value thrown by the binding onto {@link ArtifactsError}, keeping the
 * platform's `code` / `numericCode` when it attached them.
 */
const toArtifactsError = (error: any): ArtifactsError =>
  new ArtifactsError({
    message: error?.message ?? "Unknown error",
    code: isArtifactsErrorCode(error?.code) ? error.code : undefined,
    numericCode: typeof error?.numericCode === "number" ? error.numericCode : undefined,
    cause: error,
  });

const tryPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, ArtifactsError> =>
  Effect.tryPromise({ try: fn, catch: toArtifactsError });

/** Wrap a runtime repo handle so each method returns an Effect. */
export const makeArtifactsRepoClient = (raw: RepoHandle): RepoClient => ({
  raw,
  info: () => tryPromise(() => raw.info()),
  listTokens: () => tryPromise(() => raw.listTokens()),
  log: (opts) => tryPromise(() => raw.log(opts)),
  readCommit: (hash) => tryPromise(() => raw.readCommit(hash)),
  readTree: (hash) => tryPromise(() => raw.readTree(hash)),
  readBlob: (hash) => tryPromise(() => raw.readBlob(hash)),
  readFile: (args) => tryPromise(() => raw.readFile(args)),
  createToken: (scope, ttl) => tryPromise(() => raw.createToken(scope, ttl)),
  revokeToken: (tokenOrId) => tryPromise(() => raw.revokeToken(tokenOrId)),
  fork: (name, opts) => tryPromise(() => raw.fork(name, opts)),
});

/**
 * Builds the full Artifacts client over the native worker binding. Each access
 * level (Read / Write / ReadWrite) returns this same object typed to its subset
 * — least-privilege by construction at the call site.
 */
export const makeArtifactsNamespaceClient = (
  env: Record<string, any>,
  namespace: Namespace,
): ReadWriteNamespaceClient => {
  // Lazy — the WorkerEnvironment binding is not populated until runtime.
  const raw = Effect.sync(() => (env as Record<string, Artifacts>)[namespace.name]!);
  const use = <T>(fn: (raw: Artifacts) => Promise<T>): Effect.Effect<T, ArtifactsError> =>
    raw.pipe(Effect.flatMap((raw) => tryPromise(() => fn(raw))));
  // The platform throws `NOT_FOUND` for a missing repo; a `null` is mapped the
  // same way.
  const getRepo = (raw: Artifacts, name: string): Promise<RepoHandle | null> => raw.get(name);
  return {
    raw,
    create: (name, opts) => use((raw) => raw.create(name, opts)),
    get: (name) =>
      use((raw) => getRepo(raw, name)).pipe(
        Effect.flatMap((repo) =>
          repo == null
            ? Effect.fail(
                new ArtifactsError({
                  message: `Artifacts repo '${name}' not found`,
                  code: "NOT_FOUND",
                  numericCode: NOT_FOUND_NUMERIC_CODE,
                  cause: new Error("not_found"),
                }),
              )
            : Effect.succeed(makeArtifactsRepoClient(repo)),
        ),
      ),
    list: (opts) => use((raw) => raw.list(opts)),
    delete: (name) => use((raw) => raw.delete(name)),
    import: (opts) => use((raw) => raw.import(opts)),
  };
};
