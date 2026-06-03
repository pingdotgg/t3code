import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import { type Artifacts as ArtifactsLike } from "./Artifacts.ts";

export class ArtifactsError extends Data.TaggedError("ArtifactsError")<{
  message: string;
  cause: Error;
}> {}

export type Scope = "read" | "write";

export type ArtifactsCreateOptions = {
  readOnly?: boolean;
  description?: string;
  setDefaultBranch?: string;
};

export type ArtifactsImportOptions = {
  source: { url: string; branch?: string; depth?: number };
  target: {
    name: string;
    opts?: { description?: string; readOnly?: boolean };
  };
};

export type ArtifactsListOptions = {
  limit?: number;
  cursor?: string;
};

export type ArtifactsForkOptions = {
  description?: string;
  readOnly?: boolean;
  defaultBranchOnly?: boolean;
};

/**
 * Effect-native handle to a single Artifacts repo. Wraps the runtime
 * {@link ArtifactsRepo} so each method returns an Effect.
 */
export interface ArtifactsRepoClient {
  /** Underlying Cloudflare runtime handle. */
  raw: ArtifactsRepo;
  createToken(
    scope?: Scope,
    ttl?: number,
  ): Effect.Effect<ArtifactsCreateTokenResult, ArtifactsError>;
  listTokens(): Effect.Effect<ArtifactsTokenListResult, ArtifactsError>;
  revokeToken(tokenOrId: string): Effect.Effect<boolean, ArtifactsError>;
  fork(
    name: string,
    opts?: ArtifactsForkOptions,
  ): Effect.Effect<ArtifactsCreateRepoResult, ArtifactsError>;
}

/**
 * Effect-native client for a Cloudflare Artifacts namespace binding.
 *
 * Wraps the runtime {@link Artifacts} binding so each method returns an
 * Effect tagged with {@link ArtifactsError}. Use
 * `Cloudflare.ArtifactsBinding.bind(Repos)` inside a Worker's init phase.
 */
export interface ArtifactsClient {
  /** Effect resolving to the raw Cloudflare runtime binding. */
  raw: Effect.Effect<Artifacts, never, RuntimeContext>;
  create(
    name: string,
    opts?: ArtifactsCreateOptions,
  ): Effect.Effect<ArtifactsCreateRepoResult, ArtifactsError, RuntimeContext>;
  /** Look up an existing repo by name. Fails with `ArtifactsError` if missing. */
  get(
    name: string,
  ): Effect.Effect<ArtifactsRepoClient, ArtifactsError, RuntimeContext>;
  list(
    opts?: ArtifactsListOptions,
  ): Effect.Effect<ArtifactsRepoListResult, ArtifactsError, RuntimeContext>;
  delete(name: string): Effect.Effect<boolean, ArtifactsError, RuntimeContext>;
  import(
    opts: ArtifactsImportOptions,
  ): Effect.Effect<ArtifactsCreateRepoResult, ArtifactsError, RuntimeContext>;
}

export class ArtifactsBinding extends Binding.Service<
  ArtifactsBinding,
  (artifacts: ArtifactsLike) => Effect.Effect<ArtifactsClient>
>()("Cloudflare.Artifacts.Binding") {}

export const ArtifactsBindingLive = Layer.effect(
  ArtifactsBinding,
  Effect.gen(function* () {
    const Policy = yield* ArtifactsBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (artifacts: ArtifactsLike) {
      yield* Policy(artifacts);
      const raw = Effect.sync(
        () => (env as Record<string, Artifacts>)[artifacts.name]!,
      );

      const use = <T>(
        fn: (raw: Artifacts) => Promise<T>,
      ): Effect.Effect<T, ArtifactsError> =>
        raw.pipe(Effect.flatMap((raw) => tryPromise(() => fn(raw))));

      return {
        raw,
        create: (name, opts) => use((raw) => raw.create(name, opts)),
        get: (name) =>
          use((raw) => raw.get(name)).pipe(
            Effect.flatMap((repo) =>
              repo == null
                ? Effect.fail(
                    new ArtifactsError({
                      message: `Artifacts repo '${name}' not found`,
                      cause: new Error("not_found"),
                    }),
                  )
                : Effect.succeed(wrapRepo(repo as ArtifactsRepo)),
            ),
          ),
        list: (opts) => use((raw) => raw.list(opts)),
        delete: (name) => use((raw) => raw.delete(name)),
        import: (opts) => use((raw) => raw.import(opts)),
      } satisfies ArtifactsClient;
    });
  }),
);

export class ArtifactsBindingPolicy extends Binding.Policy<
  ArtifactsBindingPolicy,
  (artifacts: ArtifactsLike) => Effect.Effect<void>
>()("Cloudflare.Artifacts.Binding") {}

export const ArtifactsBindingPolicyLive = ArtifactsBindingPolicy.layer.succeed(
  Effect.fn(function* (host: ResourceLike, artifacts: ArtifactsLike) {
    if (isWorker(host)) {
      yield* host.bind(artifacts.name, {
        bindings: [
          {
            type: "artifacts",
            name: artifacts.name,
            namespace: artifacts.namespace,
          } as any,
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`ArtifactsBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);

const tryPromise = <T>(
  fn: () => Promise<T>,
): Effect.Effect<T, ArtifactsError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error: any) =>
      new ArtifactsError({
        message: error?.message ?? "Unknown error",
        cause: error,
      }),
  });

const wrapRepo = (raw: ArtifactsRepo): ArtifactsRepoClient => ({
  raw,
  createToken: (scope, ttl) => tryPromise(() => raw.createToken(scope, ttl)),
  listTokens: () => tryPromise(() => raw.listTokens()),
  revokeToken: (tokenOrId) => tryPromise(() => raw.revokeToken(tokenOrId)),
  fork: (name, opts) => tryPromise(() => raw.fork(name, opts)),
});
