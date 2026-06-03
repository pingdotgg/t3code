import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as S from "effect/Schema";
import * as Argument from "effect/unstable/cli/Argument";
import * as CliError from "effect/unstable/cli/CliError";
import * as Flag from "effect/unstable/cli/Flag";

import {
  type AuthProvider,
  AuthError,
  AuthProviders,
} from "../../Auth/AuthProvider.ts";
import type { AlchemyProfile } from "../../Auth/Profile.ts";
import type * as Stack from "../../Stack.ts";
import { recordCli } from "../../Telemetry/Metrics.ts";
import { PromptCancelled } from "../../Util/Clank.ts";

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
    "Auth profile to use (~/.alchemy/profiles.json). Defaults to 'default' or $ALCHEMY_PROFILE.",
  ),
  Flag.optional,
  Flag.map(Option.getOrElse(() => "default")),
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
  stored: AlchemyProfile,
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
    yield* provider.prettyPrint(profile, cfg);
  }
});

export const importStack = Effect.fn(function* (main: string) {
  const path = yield* Path.Path;
  const url = import.meta.resolve(path.resolve(main));
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
