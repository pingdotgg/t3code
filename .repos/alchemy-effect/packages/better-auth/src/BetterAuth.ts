import type { RuntimeContext } from "alchemy";
import { Random } from "alchemy";
import type { HttpEffect } from "alchemy/Http";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { makeApiProxy, type BetterAuthApi } from "./ApiProxy.ts";
import { Database } from "./Database.ts";
import type { BetterAuthApiError } from "./Errors.ts";
import { SecondaryStorage, toPromiseStorage } from "./SecondaryStorage.ts";

/**
 * Better Auth options, minus the fields alchemy owns:
 *
 * - `database` comes from the {@link Database} platform layer
 *   (`Cloudflare.D1`, `Postgres`, `Memory`, ...)
 * - `secondaryStorage` comes from the optional {@link SecondaryStorage}
 *   layer (`Cloudflare.KV`)
 * - `secret` is widened to accept `Redacted` values and Effects (resource
 *   outputs), and defaults to an auto-provisioned stable random secret
 *
 * plus alchemy extensions (`id`, `migrate`).
 */
export interface BetterAuthProps extends Omit<
  BetterAuthOptions,
  "database" | "secondaryStorage" | "secret"
> {
  /**
   * Distinguishes multiple BetterAuth instances in one namespace — suffixes
   * the auto-provisioned secret resource and the migration action logical
   * ids.
   *
   * @default "BetterAuth"
   */
  readonly id?: string;
  /**
   * Deploy-time automatic schema migration. Runs as an internal alchemy
   * Action during `alchemy deploy` (never at plan, never inside the
   * deployed runtime) and re-runs only when the auth schema (plugins,
   * additional fields) or the target database changes.
   *
   * `false` opts out. `true` on a Database layer without migration support
   * (Memory, Drizzle) fails the deploy with a descriptive error.
   *
   * @default true when the Database layer supports migration
   */
  readonly migrate?: boolean;
  /**
   * The Better Auth signing secret. Accepts a literal string, a `Redacted`
   * value, or an Effect resolving to one (e.g. another resource's output
   * accessor).
   *
   * @default an auto-provisioned `Alchemy.Random` secret (`${id}Secret`),
   * generated once and stable across deploys
   */
  readonly secret?:
    | string
    | Redacted.Redacted<string>
    | Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext>;
}

/**
 * The Better Auth options type seen by `Auth<Options>` — the user's literal
 * options with the alchemy extension fields stripped, so plugin/session/user
 * type inference flows through untouched.
 */
export type AuthOptions<O extends BetterAuthProps> =
  Omit<O, "id" | "migrate" | "secret"> extends infer T extends BetterAuthOptions
    ? T
    : BetterAuthOptions;

/** The inferred `{ session, user }` shape for a given options type. */
export type Session<O extends BetterAuthProps> = Auth<
  AuthOptions<O>
>["$Infer"]["Session"];

export interface BetterAuthInstance<O extends BetterAuthProps> {
  /**
   * The per-execution Better Auth instance (memoized on the execution
   * scope). Escape hatch for anything the effectified surface doesn't
   * cover (`$context`, `asResponse`/`returnHeaders` call forms, ...).
   */
  readonly auth: Effect.Effect<Auth<AuthOptions<O>>, never, RuntimeContext>;
  /**
   * Every `auth.api.*` endpoint mirrored as an Effect with a typed
   * {@link BetterAuthApiError} failure.
   */
  readonly api: BetterAuthApi<Auth<AuthOptions<O>>["api"]>;
  /**
   * HTTP handler for the Better Auth routes — mount it under your
   * `basePath` (default `/api/auth`):
   *
   * ```typescript
   * fetch: Effect.gen(function* () {
   *   const request = yield* HttpServerRequest;
   *   if (request.url.startsWith("/api/auth")) {
   *     return yield* auth.fetch;
   *   }
   *   // ...
   * })
   * ```
   */
  readonly fetch: HttpEffect<RuntimeContext>;
  /**
   * Look up the session for the ambient request (or explicit `Headers`).
   * Resolves `null` for anonymous requests — failures are real errors, not
   * missing sessions.
   */
  readonly getSession: {
    (): Effect.Effect<
      Session<O> | null,
      BetterAuthApiError,
      RuntimeContext | HttpServerRequest.HttpServerRequest
    >;
    (
      headers: Headers,
    ): Effect.Effect<Session<O> | null, BetterAuthApiError, RuntimeContext>;
  };
  /** Type-level mirror of `auth.$Infer` (phantom — no runtime value). */
  readonly Infer: Auth<AuthOptions<O>>["$Infer"];
}

/**
 * Create a Better Auth instance wired to alchemy.
 *
 * The database comes from a {@link Database} platform layer provided on
 * the surrounding Worker/Function impl effect; the signing secret defaults
 * to a stable auto-provisioned random secret; schema migrations run
 * automatically at deploy time.
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const auth = yield* BetterAuth({
 *     basePath: "/api/auth",
 *     emailAndPassword: { enabled: true },
 *   });
 *   return { fetch: ... };
 * }).pipe(Effect.provide(CloudflareD1(Db)))
 * ```
 */
export const BetterAuth = <const O extends BetterAuthProps>(
  options: O,
): Effect.Effect<BetterAuthInstance<O>, never, Database> =>
  Effect.gen(function* () {
    const {
      id = "BetterAuth",
      migrate,
      secret,
      ...userOptions
    } = options as BetterAuthProps;
    const authOptions = userOptions as BetterAuthOptions;

    const db = yield* Database;
    const secondary = yield* Effect.serviceOption(SecondaryStorage);

    // Resolve the signing secret to an Effect usable at runtime. The
    // default is a Random resource whose Output accessor binds the value
    // into the host environment at deploy and reads it back at runtime.
    let secretAccessor: Effect.Effect<Redacted.Redacted<string>>;
    if (secret === undefined) {
      const resource = yield* Random(`${id}Secret`);
      secretAccessor = yield* resource.text;
    } else if (typeof secret === "string") {
      secretAccessor = Effect.succeed(Redacted.make(secret));
    } else if (Effect.isEffect(secret)) {
      secretAccessor = secret as Effect.Effect<Redacted.Redacted<string>>;
    } else {
      secretAccessor = Effect.succeed(secret);
    }

    // Deploy-time migration registration. The whole block — including the
    // Migrate module with its better-auth/db + kysely imports — is
    // unreachable at runtime and dead-code-eliminated from bundles.
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const { registerMigration } = yield* Effect.promise(
        () => import("./Migrate.ts"),
      );
      yield* registerMigration({ id, options: authOptions, db, migrate });
    }

    // One Better Auth instance per execution (Worker event, DO call,
    // Lambda invoke): the database input may hold sockets (pg/mysql
    // pools), which are IoContext-pinned on workerd — they are acquired
    // on the execution scope and released when the event settles.
    const makeAuth = yield* makeExecutionMemo(
      Effect.gen(function* () {
        const database = yield* db.runtime;
        const secretValue = Redacted.value(yield* secretAccessor);

        // Background tasks (better-auth's internal fire-and-forget work)
        // are awaited by a finalizer on the execution scope — the bridges
        // register it with `ctx.waitUntil` on workerd and settle it
        // inline on Lambda.
        const pending: Promise<unknown>[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => Promise.allSettled(pending)),
        );

        const context = yield* Effect.context<RuntimeContext>();
        const runPromise = <A, E>(
          effect: Effect.Effect<A, E, RuntimeContext>,
        ): Promise<A> =>
          Effect.runPromise(
            effect.pipe(Effect.provideContext(context)) as Effect.Effect<A, E>,
          );

        return betterAuth({
          ...authOptions,
          database,
          secret: secretValue,
          ...(Option.isSome(secondary)
            ? {
                secondaryStorage: toPromiseStorage(secondary.value, runPromise),
              }
            : {}),
          advanced: {
            ...authOptions.advanced,
            backgroundTasks: authOptions.advanced?.backgroundTasks ?? {
              handler: (promise) => {
                pending.push(promise);
              },
            },
          },
        }) as unknown as Auth<AuthOptions<O>>;
      }),
    );

    const api = makeApiProxy<Auth<AuthOptions<O>>>(makeAuth);

    const fetch: HttpEffect<RuntimeContext> = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
        Effect.orDie,
      );
      const auth = yield* makeAuth;
      // `auth.handler` never rejects for API errors — they come back as
      // error Responses, exactly what a pass-through route wants.
      const response = yield* Effect.promise(() => auth.handler(webRequest));
      return HttpServerResponse.fromWeb(response);
    });

    const apiAny = api as Record<
      string,
      (
        input: unknown,
      ) => Effect.Effect<unknown, BetterAuthApiError, RuntimeContext>
    >;
    const getSession = ((headers?: Headers) =>
      headers === undefined
        ? Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
              Effect.orDie,
            );
            return yield* apiAny.getSession!({ headers: webRequest.headers });
          })
        : apiAny.getSession!({
            headers,
          })) as BetterAuthInstance<O>["getSession"];

    return {
      auth: makeAuth,
      api,
      fetch,
      getSession,
      Infer: undefined as unknown as BetterAuthInstance<O>["Infer"],
    } satisfies BetterAuthInstance<O>;
  }).pipe(
    (effect) =>
      // Deploy-only requirements picked up by the init effect — the Random
      // provider during stack evaluation, RuntimeContext for Output binds,
      // Stack for migration Action registration — are provided ambiently by
      // stack evaluation at deploy and by the bridge at runtime. They are
      // erased from the public type (same doctrine as `makeExecutionMemo`
      // erasing `Scope`); the one requirement the CALLER owns is `Database`.
      effect as unknown as Effect.Effect<
        BetterAuthInstance<O>,
        never,
        Database
      >,
  );
