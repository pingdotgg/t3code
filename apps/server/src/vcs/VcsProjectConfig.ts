import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  TrimmedNonEmptyString,
  VcsDriverKind,
  type VcsDriverKind as VcsDriverKindType,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

const BranchNamingConfig = Schema.Struct({
  defaultPrefix: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  preserveNamespaces: Schema.optional(Schema.Boolean),
});

const ShellHookCommands = Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1));
const ArgvHookCommand = Schema.TupleWithRest(Schema.Tuple([TrimmedNonEmptyString]), [
  Schema.String,
]);
const ArgvHookCommands = Schema.Array(ArgvHookCommand).check(Schema.isMinLength(1));

const HooksConfig = Schema.Struct({
  afterPush: Schema.optional(Schema.NullOr(Schema.Union([ShellHookCommands, ArgvHookCommands]))),
  changeRequestContext: Schema.optional(
    Schema.NullOr(Schema.Union([TrimmedNonEmptyString, ArgvHookCommand])),
  ),
});

const ProjectVcsConfig = Schema.Struct({
  vcs: Schema.optional(
    Schema.Struct({
      kind: Schema.optional(VcsDriverKind),
    }),
  ),
  vcsKind: Schema.optional(VcsDriverKind),
  branchNaming: Schema.optional(BranchNamingConfig),
  hooks: Schema.optional(HooksConfig),
});
const ProjectVcsConfigJson = fromLenientJson(ProjectVcsConfig);
const decodeProjectVcsConfigJson = Schema.decodeUnknownEffect(ProjectVcsConfigJson);

type ProjectVcsConfigFile = typeof ProjectVcsConfig.Type;

export interface VcsProjectConfigResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKindType | "auto";
}

export interface VcsBranchNamingConfig {
  readonly defaultPrefix: string | null;
  readonly preserveNamespaces: boolean;
}

export interface VcsHooksConfig {
  readonly afterPush:
    | ReadonlyArray<string>
    | ReadonlyArray<readonly [string, ...ReadonlyArray<string>]>
    | null;
}

export const defaultBranchNamingConfig: VcsBranchNamingConfig = {
  defaultPrefix: "feature",
  preserveNamespaces: false,
};

export const defaultHooksConfig: VcsHooksConfig = {
  afterPush: null,
};

export class VcsProjectConfigError extends Schema.TaggedError<VcsProjectConfigError>()(
  "VcsProjectConfigError",
  {
    operation: Schema.Literals(["inspect", "read", "decode"]),
    cwd: Schema.String,
    configPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} VCS project config at ${this.configPath}.`;
  }
}

export class VcsProjectConfig extends Context.Service<
  VcsProjectConfig,
  {
    readonly resolveKind: (
      input: VcsProjectConfigResolveInput,
    ) => Effect.Effect<VcsDriverKindType | "auto">;
    readonly resolveBranchNaming: (input: {
      readonly cwd: string;
      readonly fallback?: VcsBranchNamingConfig;
    }) => Effect.Effect<VcsBranchNamingConfig>;
    readonly resolveHooks: (input: { readonly cwd: string }) => Effect.Effect<VcsHooksConfig>;
    readonly resolveChangeRequestContext: (input: {
      readonly cwd: string;
    }) => Effect.Effect<string | readonly [string, ...string[]] | null, VcsProjectConfigError>;
  }
>()("t3/vcs/VcsProjectConfig") {}

function configuredKind(config: ProjectVcsConfigFile): VcsDriverKindType | "auto" {
  return config.vcs?.kind ?? config.vcsKind ?? "auto";
}

function configuredBranchNaming(
  config: ProjectVcsConfigFile,
  fallback = defaultBranchNamingConfig,
): VcsBranchNamingConfig {
  const configuredPrefix = config.branchNaming?.defaultPrefix;
  return {
    defaultPrefix: configuredPrefix === undefined ? fallback.defaultPrefix : configuredPrefix,
    preserveNamespaces: config.branchNaming?.preserveNamespaces ?? fallback.preserveNamespaces,
  };
}

function configuredHooks(config: ProjectVcsConfigFile): VcsHooksConfig {
  return {
    afterPush: config.hooks?.afterPush ?? defaultHooksConfig.afterPush,
  };
}

const logVcsProjectConfigError = (error: VcsProjectConfigError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      cwd: error.cwd,
      configPath: error.configPath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const findConfigPath = Effect.fn("VcsProjectConfig.findConfigPath")(function* (cwd: string) {
    let current = cwd;
    while (true) {
      const candidate = path.join(current, ".t3code", "vcs.json");
      const exists = yield* fileSystem.exists(candidate).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProjectConfigError({
              operation: "inspect",
              cwd,
              configPath: candidate,
              cause,
            }),
        ),
        Effect.catchTags({
          VcsProjectConfigError: (error) => logVcsProjectConfigError(error).pipe(Effect.as(false)),
        }),
      );
      if (exists) {
        return Option.some(candidate);
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return Option.none();
      }
      current = parent;
    }
  });

  const readConfig = Effect.fn("VcsProjectConfig.readConfig")(function* (
    cwd: string,
    configPath: string,
  ) {
    const raw = yield* fileSystem.readFileString(configPath).pipe(
      Effect.mapError(
        (cause) =>
          new VcsProjectConfigError({
            operation: "read",
            cwd,
            configPath,
            cause,
          }),
      ),
    );
    const parsed = yield* decodeProjectVcsConfigJson(raw).pipe(
      Effect.mapError(
        (cause) =>
          new VcsProjectConfigError({
            operation: "decode",
            cwd,
            configPath,
            cause,
          }),
      ),
    );
    return parsed;
  });

  const resolveConfig = Effect.fn("VcsProjectConfig.resolveConfig")(function* (cwd: string) {
    return yield* findConfigPath(cwd).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<ProjectVcsConfigFile>()),
          onSome: (configPath) => readConfig(cwd, configPath).pipe(Effect.asSome),
        }),
      ),
      Effect.catchTags({
        VcsProjectConfigError: (error) =>
          logVcsProjectConfigError(error).pipe(Effect.as(Option.none<ProjectVcsConfigFile>())),
      }),
    );
  });

  const resolveKind: VcsProjectConfig["Service"]["resolveKind"] = Effect.fn(
    "VcsProjectConfig.resolveKind",
  )(function* (input) {
    if (input.requestedKind !== undefined && input.requestedKind !== "auto") {
      return input.requestedKind;
    }

    return yield* resolveConfig(input.cwd).pipe(
      Effect.map(
        Option.match({
          onNone: () => "auto" as const,
          onSome: configuredKind,
        }),
      ),
    );
  });

  const resolveBranchNaming: VcsProjectConfig["Service"]["resolveBranchNaming"] = Effect.fn(
    "VcsProjectConfig.resolveBranchNaming",
  )(function* (input) {
    return yield* resolveConfig(input.cwd).pipe(
      Effect.map(
        Option.match({
          onNone: () => input.fallback ?? defaultBranchNamingConfig,
          onSome: (config) => configuredBranchNaming(config, input.fallback),
        }),
      ),
    );
  });

  const resolveHooks: VcsProjectConfig["Service"]["resolveHooks"] = Effect.fn(
    "VcsProjectConfig.resolveHooks",
  )(function* (input) {
    return yield* resolveConfig(input.cwd).pipe(
      Effect.map(
        Option.match({
          onNone: () => defaultHooksConfig,
          onSome: configuredHooks,
        }),
      ),
    );
  });

  const resolveChangeRequestContext: VcsProjectConfig["Service"]["resolveChangeRequestContext"] =
    Effect.fn("VcsProjectConfig.resolveChangeRequestContext")(function* (input) {
      const configPath = yield* findConfigPath(input.cwd);
      if (Option.isNone(configPath)) return null;
      const config = yield* readConfig(input.cwd, configPath.value);
      return config.hooks?.changeRequestContext ?? null;
    });

  return VcsProjectConfig.of({
    resolveKind,
    resolveBranchNaming,
    resolveHooks,
    resolveChangeRequestContext,
  });
});

export const layer = Layer.effect(VcsProjectConfig, make);
