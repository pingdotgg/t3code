import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Argument from "effect/unstable/cli/Argument";
import * as Flag from "effect/unstable/cli/Flag";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { UserInputError } from "./errors.ts";

export const USER = Config.String("USER").pipe(
  Config.orElse(() => Config.String("USERNAME")),
  Config.withDefault("unknown"),
);

export const ALCHEMY_STAGE = Config.String("ALCHEMY_STAGE").pipe(
  Config.option,
  Effect.map(Option.getOrUndefined),
);

const STAGE_NAME_PATTERN = /^[a-z0-9]+([-_a-z0-9]+)*$/i;

const makeStageFlag = (kind: "live" | "dev") =>
  Flag.String("stage").pipe(
    Flag.withSchema(
      Schema.String.check(Schema.isPattern(/^[a-z0-9]+([-_a-z0-9]+)*$/gi)),
    ),
    Flag.withDescription(
      kind === "live"
        ? "Stage to deploy to. Defaults to $ALCHEMY_STAGE or live_${USER}"
        : "Stage to use for dev. Defaults to $ALCHEMY_STAGE or dev_${USER}",
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  );

/** `--stage` for deploy / destroy / plan / logs / drift. Default: `live_$USER`. */
export const stage = makeStageFlag("live");

/** `--stage` for `alchemy dev`. Default: `dev_$USER`. */
export const devStage = makeStageFlag("dev");

/**
 * Resolve the target stage after the command's dotenv provider is known.
 * `--stage` wins; otherwise `$ALCHEMY_STAGE` from process env / `--env-file`
 * / `.env`; otherwise `live_$USER` or `dev_$USER`.
 *
 * `$STAGE` is not consulted. Use `$ALCHEMY_STAGE` so stage selection
 * matches `$ALCHEMY_PROFILE`.
 */
export const resolveStage = Effect.fn(function* (
  kind: "live" | "dev",
  override: string | undefined,
  envFile: Option.Option<string>,
) {
  if (override) return override;
  const provider = yield* loadConfigProvider(envFile);
  const configured = yield* ALCHEMY_STAGE.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (configured !== undefined && configured !== "") {
    if (!STAGE_NAME_PATTERN.test(configured)) {
      return yield* new UserInputError({
        message: `Invalid $ALCHEMY_STAGE '${configured}'. Must match [a-z0-9]+([-_a-z0-9]+)*.`,
      });
    }
    return configured;
  }
  return yield* USER.pipe(
    Effect.map((user) => `${kind}_${user}`),
    Effect.catch(() => Effect.succeed(`${kind}_unknown`)),
  );
});

export const envFile = Flag.File("env-file").pipe(
  Flag.optional,
  Flag.withDescription(
    "File to load environment variables from, defaults to .env",
  ),
);

export const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Dry run the deployment, do not actually deploy"),
  Flag.withDefault(false),
);

export const yes = Flag.Boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDescription("Yes to all prompts"),
  Flag.withDefault(false),
);

export const force = Flag.Boolean("force").pipe(
  Flag.withDescription(
    "Force updates for resources that would otherwise no-op",
  ),
  Flag.withDefault(false),
);

export const config = Flag.File("config", { mustExist: true }).pipe(
  Flag.withDescription("Alchemy entrypoint file (default: alchemy.run.ts)"),
  Flag.withAlias("c"),
  Flag.withDefault("alchemy.run.ts"),
);

export const optionalConfig = Flag.File("config", { mustExist: true }).pipe(
  Flag.withDescription("Alchemy entrypoint file (default: alchemy.run.ts)"),
  Flag.withAlias("c"),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

export const configPath = Argument.File("config", { mustExist: true }).pipe(
  Argument.withDescription("Alchemy entrypoint file (default: alchemy.run.ts)"),
  Argument.optional,
  Argument.map(Option.getOrUndefined),
);

export const resolveConfig = <
  A extends {
    readonly config: string | undefined;
    readonly configPath: string | undefined;
  },
>(
  args: A,
) =>
  Effect.gen(function* () {
    if (args.config !== undefined && args.configPath !== undefined) {
      return yield* new UserInputError({
        message:
          "Pass the config path either positionally or with --config, not both.",
      });
    }
    return {
      ...args,
      main: args.config ?? args.configPath ?? "alchemy.run.ts",
    };
  });

export const resolveStackArgs =
  (kind: "live" | "dev") =>
  <
    A extends {
      readonly config: string | undefined;
      readonly configPath: string | undefined;
      readonly stage: string | undefined;
      readonly envFile: Option.Option<string>;
    },
  >(
    args: A,
  ) =>
    Effect.gen(function* () {
      const resolved = yield* resolveConfig(args);
      const stage = yield* resolveStage(kind, args.stage, args.envFile);
      return { ...resolved, stage };
    });

export const profile = Flag.String("profile").pipe(
  Flag.withDescription(
    "Auth profile to use. Defaults to $ALCHEMY_PROFILE or 'default'.",
  ),
  Flag.optional,
  Flag.map(Option.getOrUndefined),
);

export const parseSince = (value: string) =>
  Effect.gen(function* () {
    const match = value.match(/^(\d+)([smhd])$/);
    if (match) {
      const amount = match[1];
      const unit = match[2];
      if (amount === undefined || unit === undefined) {
        return yield* new UserInputError({
          message: `Invalid --since value: '${value}'.`,
        });
      }
      const num = parseInt(amount, 10);
      const duration =
        unit === "s"
          ? Duration.seconds(num)
          : unit === "m"
            ? Duration.minutes(num)
            : unit === "h"
              ? Duration.hours(num)
              : Duration.days(num);
      const now = yield* Clock.currentTimeMillis;
      return new Date(now - Duration.toMillis(duration));
    }
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) {
      return yield* new UserInputError({
        message: `Invalid --since value: '${value}'. Use a duration (e.g. '1h', '30m') or ISO date.`,
      });
    }
    return parsed;
  });
