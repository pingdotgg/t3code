import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as S from "effect/Schema";
import * as Argument from "effect/unstable/cli/Argument";
import * as CliError from "effect/unstable/cli/CliError";
import * as Flag from "effect/unstable/cli/Flag";
import { pathToFileURL } from "node:url";

import {
  type AuthProvider,
  AuthError,
  AuthProviders,
} from "../../Auth/AuthProvider.ts";
import {
  type AlchemyProfileProviders,
  ALCHEMY_PROFILE,
  withProfileOverride,
} from "../../Auth/Profile.ts";
import { AwsAuth } from "../../AWS/AuthProvider.ts";
import { AxiomAuth } from "../../Axiom/AuthProvider.ts";
import { CloudflareAuth } from "../../Cloudflare/Auth/AuthProvider.ts";
import { GitHubAuth } from "../../GitHub/AuthProvider.ts";
import { NeonAuth } from "../../Neon/AuthProvider.ts";
import { PlanetscaleAuth } from "../../Planetscale/AuthProvider.ts";
import * as Stack from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { recordCli } from "../../Telemetry/Metrics.ts";
import { PromptCancelled } from "../../Util/Clank.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";

export const USER = Config.string("USER").pipe(
  Config.orElse(() => Config.string("USERNAME")),
  Config.withDefault("unknown"),
);

export const STAGE = Config.string("stage").pipe(
  Config.option,
  (a) => a,
  Effect.map(Option.getOrUndefined),
);

/**
 * `true` if `e` is a {@link PromptCancelled}, or an {@link AuthError} whose
 * `cause` chain bottoms out in one. Schema-tagged errors don't always
 * survive `instanceof` across module boundaries, so we also accept any
 * object whose `_tag` matches.
 */
const isPromptCancellation = (e: unknown): boolean => {
  for (let cur: unknown = e, i = 0; cur != null && i < 16; i++) {
    if (cur instanceof PromptCancelled) return true;
    if (
      typeof cur === "object" &&
      (cur as { _tag?: unknown })._tag === "PromptCancelled"
    ) {
      return true;
    }
    if (
      cur instanceof AuthError ||
      (typeof cur === "object" &&
        (cur as { _tag?: unknown })._tag === "AuthError")
    ) {
      cur = (cur as { cause?: unknown }).cause;
      continue;
    }
    return false;
  }
  return false;
};

/**
 * Catches user cancellations (Ctrl+C inside a prompt, surfaced as
 * {@link PromptCancelled} or wrapped in an {@link AuthError}) and exits
 * the CLI cleanly with a friendly message instead of dumping a stack
 * trace.
 */
export const handleCancellation = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  self.pipe(
    Effect.catchCause((cause) => {
      const cancelled = cause.reasons.some((r) => {
        if (Cause.isFailReason(r)) return isPromptCancellation(r.error);
        if (Cause.isDieReason(r)) return isPromptCancellation(r.defect);
        return false;
      });
      return cancelled
        ? Console.log("\nCancelled.")
        : (Effect.failCause(cause) as Effect.Effect<never, E, never>);
    }),
    // A bare fiber interrupt (Ctrl+C while not inside a prompt) shouldn't
    // dump a stack trace either.
    Effect.onInterrupt(() => Console.log("\nInterrupted.")),
  );

export const stage = Flag.string("stage").pipe(
  Flag.withSchema(S.String.check(S.isPattern(/^[a-z0-9]+([-_a-z0-9]+)*$/gi))),
  Flag.withDescription("Stage to deploy to, defaults to dev_${USER}"),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
  Flag.mapEffect(
    Effect.fn(function* (stage) {
      if (stage) {
        return stage;
      }
      return yield* STAGE.pipe(
        Effect.catch(() =>
          Effect.fail(
            new CliError.MissingOption({
              option: "stage",
            }),
          ),
        ),
        Effect.flatMap((s) =>
          s === undefined
            ? USER.pipe(
                Effect.map((user) => `dev_${user}`),
                Effect.catch(() => Effect.succeed("unknown")),
              )
            : Effect.succeed(s),
        ),
      );
    }),
  ),
);

export const envFile = Flag.file("env-file").pipe(
  Flag.optional,
  Flag.withDescription(
    "File to load environment variables from, defaults to .env",
  ),
);

export const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Dry run the deployment, do not actually deploy"),
  Flag.withDefault(false),
);

export const yes = Flag.boolean("yes").pipe(
  Flag.withDescription("Yes to all prompts"),
  Flag.withDefault(false),
);

export const force = Flag.boolean("force").pipe(
  Flag.withDescription(
    "Force updates for resources that would otherwise no-op",
  ),
  Flag.withDefault(false),
);

export const script = Argument.file("main", {
  mustExist: true,
}).pipe(
  Argument.withDescription("Main file to deploy, defaults to alchemy.run.ts"),
  Argument.withDefault("alchemy.run.ts"),
);

export const profile = Flag.string("profile").pipe(
  Flag.withDescription(
    "Auth profile to use (~/.alchemy/profiles.json). Defaults to $ALCHEMY_PROFILE or 'default'.",
  ),
  Flag.optional,
  Flag.mapEffect(
    Effect.fn(function* (profile) {
      // --profile wins; otherwise fall back to $ALCHEMY_PROFILE (which
      // itself defaults to "default"). Without this, the flag's default
      // would shadow the env var via withProfileOverride.
      if (Option.isSome(profile)) {
        return profile.value;
      }
      return yield* ALCHEMY_PROFILE.pipe(
        Effect.catch(() => Effect.succeed("default")),
      );
    }),
  ),
);

export const resourceFilter = Flag.string("filter").pipe(
  Flag.withDescription(
    "Comma-separated logical resource IDs (e.g. Api,Sandbox). Only those resources are included.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

export const TAIL_COLORS = [
  "\x1b[36m", // cyan
  "\x1b[35m", // magenta
  "\x1b[33m", // yellow
  "\x1b[32m", // green
  "\x1b[34m", // blue
  "\x1b[91m", // bright red
  "\x1b[96m", // bright cyan
  "\x1b[95m", // bright magenta
  "\x1b[93m", // bright yellow
  "\x1b[92m", // bright green
];
export const TAIL_RESET = "\x1b[0m";

export const formatLocalTimestamp = (date: Date): string => {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  const tz =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${ms} ${tz}`;
};

export const parseResourceFilter = (
  filter: string | undefined,
): ReadonlySet<string> | undefined => {
  if (filter === undefined) return undefined;
  const ids = filter
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) return undefined;
  return new Set(ids);
};

export const parseSince = (value: string): Date => {
  const match = value.match(/^(\d+)([smhd])$/);
  if (match) {
    const num = parseInt(match[1]!, 10);
    const unit = match[2]!;
    const ms =
      unit === "s"
        ? num * 1000
        : unit === "m"
          ? num * 60_000
          : unit === "h"
            ? num * 3_600_000
            : num * 86_400_000;
    return new Date(Date.now() - ms);
  }
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid --since value: '${value}'. Use a duration (e.g. '1h', '30m') or ISO date.`,
    );
  }
  return parsed;
};

/**
 * Wraps a CLI command handler with a top-level OpenTelemetry span
 * (`cli.<command>`) and bumps the `alchemy.cli.invocations` counter.
 *
 * `attrs` runs against the parsed command args and contributes
 * additional attributes to the span (e.g. stage, profile, dry-run flag).
 *
 * Usage:
 * ```ts
 * Command.make(
 *   "deploy",
 *   { ...flags },
 *   instrumentCommand("deploy", (a) => ({
 *     "alchemy.stage": a.stage,
 *     "alchemy.profile": a.profile,
 *   }))(execStack),
 * );
 * ```
 */
export const instrumentCommand =
  <AttrsArgs = unknown>(
    command: string,
    attrs?: (args: AttrsArgs) => Record<string, unknown>,
  ) =>
  <Args extends AttrsArgs, A, E, R>(
    handler: (args: Args) => Effect.Effect<A, E, R>,
  ): ((args: Args) => Effect.Effect<A, E, R>) =>
  (args) =>
    handler(args).pipe(
      Effect.withSpan(`cli.${command}`, {
        attributes: attrs ? attrs(args) : {},
      }),
      recordCli(command),
    );

/**
 * Render a profile's stored credential entries the same way across
 * `alchemy login` and `alchemy profile show`: one `── Provider ──`
 * header per entry, then either the provider's own `prettyPrint` block
 * (preferred) or a JSON-style fallback when the provider isn't
 * registered in the supplied {@link AuthProviders} registry.
 */
export const printProfile = Effect.fn(function* (
  profile: string,
  stored: AlchemyProfileProviders,
  registry: AuthProviders["Service"],
) {
  yield* Console.log(`Profile: ${profile}`);
  const names = Object.keys(stored).sort();
  if (names.length === 0) {
    yield* Console.log("(no providers configured)");
    return;
  }
  for (const name of names) {
    const cfg = stored[name]!;
    yield* Console.log("");
    yield* Console.log(`── ${name} ──`);
    const provider: AuthProvider | undefined = registry[name];
    if (provider == null) {
      yield* Console.log(`  method: ${cfg.method}`);
      const { method: _method, ...rest } = cfg as Record<string, unknown> & {
        method: string;
      };
      for (const [k, v] of Object.entries(rest)) {
        yield* Console.log(
          `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
        );
      }
      continue;
    }
    // A provider's `prettyPrint` catches its own credential-resolution
    // failures, but some resolve paths `Effect.orDie` (e.g. AWS SSO with an
    // expired token), which escapes as a defect. Contain it here — via
    // `Console.log` so the message stays on stdout under this provider's
    // header instead of interleaving on stderr — so one broken provider
    // can't abort rendering the rest of the profile.
    yield* provider.prettyPrint(profile, cfg).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        const message = error instanceof Error ? error.message : String(error);
        return Console.log(`  Failed to retrieve credentials: ${message}`);
      }),
    );
  }
});

export const importStack = Effect.fn(function* (main: string) {
  const path = yield* Path.Path;
  // Build a `file://` URL from the absolute path. `import.meta.resolve` expects a
  // module specifier / URL, not a raw filesystem path: on Windows an absolute
  // path like `D:\stack.ts` is not a valid specifier and fails to resolve, so the
  // CLI cannot load the user's stack. `pathToFileURL` produces a valid URL on
  // every platform.
  const url = pathToFileURL(path.resolve(main)).href;
  const module = yield* Effect.promise(() => import(url));
  const stackEffect = module.default as ReturnType<
    ReturnType<typeof Stack.make>
  >;
  if (!Effect.isEffect(stackEffect)) {
    return yield* Effect.die(
      new Error(
        `Main file '${main}' must export a default stack definition (export default Alchemy.Stack({...}))`,
      ),
    );
  }
  return stackEffect as typeof stackEffect & {
    stackName: string;
    stage: string;
    providers: Layer.Layer<never>;
    state: Layer.Layer<never>;
  };
});

/**
 * Placeholder {@link Stack.Stack} value used while building a stack's
 * `providers()` layer out of band. No real resources exist yet — we only
 * want the layer's provider/auth registrations and cloud-environment
 * services, so `resources`/`bindings`/`actions` are empty and the stage is a
 * sentinel.
 */
const placeholderStack = (name: string) => ({
  actions: {},
  bindings: {},
  name,
  resources: {},
  stage: "placeholder",
});

export interface BuildStackProvidersOptions {
  /** Stack entrypoint to import (e.g. `"alchemy.run.ts"`). */
  main: string;
  envFile: Option.Option<string>;
  profile: string;
  /**
   * Registry to populate. Pass a pre-seeded registry (e.g. one that already
   * has built-in providers) to layer the stack's providers on top of it,
   * overriding by name. Defaults to a fresh empty registry.
   */
  registry?: AuthProviders["Service"];
  /**
   * Logger layer used during the build. Defaults to the file logger
   * (`out`). `alchemy unsafe nuke` overrides this to log to the console in
   * debug mode.
   */
  logger?: Layer.Layer<never, never, never>;
  /**
   * Extra layer merged into the placeholder scaffold — e.g.
   * `Layer.succeed(MinimumLogLevel, ...)`, which sets a fiber-ref default
   * and so contributes no context service (`Layer<never>`).
   */
  extra?: Layer.Layer<never, never, never>;
}

/**
 * Import a stack entrypoint and build its `providers()` (+ `state()`) layer
 * out of band against placeholder {@link Stack.Stack}/{@link Stage} services,
 * so its `AuthProviderLayer` registrations land in an {@link AuthProviders}
 * registry and the built context holds every resource provider plus the
 * cloud-environment services their operations need.
 *
 * Shared by `alchemy login`, `alchemy profile show`, and `alchemy unsafe
 * nuke`. The caller decides what to do with the result — use `authProviders`
 * (login / profile show) or `context` (nuke) — and whether a missing/invalid
 * entrypoint is fatal (login / nuke let it propagate) or best-effort
 * (profile show wraps the call in `Effect.catchCause`).
 */
export const buildStackProviders = Effect.fn("buildStackProviders")(function* (
  options: BuildStackProvidersOptions,
) {
  const authProviders = options.registry ?? {};
  const stackEffect = yield* importStack(options.main);
  const configProvider = withProfileOverride(
    yield* loadConfigProvider(options.envFile),
    options.profile,
  );
  const context = yield* Layer.build(
    (stackEffect.providers ?? Layer.empty).pipe(
      Layer.provideMerge(stackEffect.state ?? Layer.empty),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(AuthProviders, authProviders),
          ConfigProvider.layer(configProvider),
          options.logger ??
            Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
          Layer.succeed(Stage, "placeholder"),
          Layer.succeed(Stack.Stack, placeholderStack(stackEffect.stackName)),
          options.extra ?? Layer.empty,
        ),
      ),
    ),
  );
  return { authProviders, context, stackEffect };
});

/**
 * The auth providers Alchemy ships with. Used as the baseline registry so
 * `alchemy login` works from any folder (no `alchemy.run.ts` required) and
 * `alchemy profile show` can pretty-print any provider a profile mentions,
 * even one the current stack doesn't wire up.
 */
export const builtinAuth = Layer.mergeAll(
  AwsAuth,
  AxiomAuth,
  CloudflareAuth,
  GitHubAuth,
  NeonAuth,
  PlanetscaleAuth,
);

/**
 * Build {@link builtinAuth} against `registry` so every built-in auth
 * provider registers itself, without importing any stack entrypoint.
 */
export const buildBuiltinAuthProviders = Effect.fn("buildBuiltinAuthProviders")(
  function* (options: {
    envFile: Option.Option<string>;
    profile: string;
    /** Registry to populate. Defaults to a fresh empty registry. */
    registry?: AuthProviders["Service"];
  }) {
    const authProviders = options.registry ?? {};
    yield* Layer.build(
      Layer.provide(
        builtinAuth,
        Layer.mergeAll(
          Layer.succeed(AuthProviders, authProviders),
          ConfigProvider.layer(
            withProfileOverride(
              yield* loadConfigProvider(options.envFile),
              options.profile,
            ),
          ),
          Logger.layer([fileLogger("out")], { mergeWithExisting: true }),
        ),
      ),
    );
    return authProviders;
  },
);
