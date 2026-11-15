import {
  TextGenerationError,
  type ModelSelection,
  type TextGenerationOperation,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const Config = Schema.Record(Schema.String, Schema.Unknown);
type Config = typeof Config.Type;
const decodeConfig = Schema.decodeUnknownOption(fromLenientJson(Config));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(Config));
const isConfig = Schema.is(Config);
const isTextGenerationError = Schema.is(TextGenerationError);
const ROUTING_KEYS = ["provider", "providers", "enabled_providers", "disabled_providers"] as const;

function readRoutingConfig(
  content: string,
  resolveFile: (file: string) => string,
): Config | undefined {
  const decoded = decodeConfig(content);
  if (Option.isNone(decoded)) return undefined;
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string")
      return value.replace(/\{file:([^}]+)\}/g, (_, file: string) => `{file:${resolveFile(file)}}`);
    if (Array.isArray(value)) return value.map(rewrite);
    if (isConfig(value))
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  return Object.fromEntries(
    ROUTING_KEYS.flatMap((key) => {
      const value = decoded.value[key];
      return value === undefined ? [] : [[key, rewrite(value)]];
    }),
  );
}

function mergeConfig(target: Config, source: Config): Config {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const previous = result[key];
    result[key] = isConfig(previous) && isConfig(value) ? mergeConfig(previous, value) : value;
  }
  return result;
}

export const makeBlindEvaluationEnvironment = Effect.fn("OpenCode.makeBlindEvaluationEnvironment")(
  function* (input: {
    readonly generation: "v1" | "v2";
    readonly operation: TextGenerationOperation;
    readonly directory: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home =
      input.environment.HOME ?? input.environment.USERPROFILE ?? (yield* HostProcess.HomeDirectory);
    const resolveFile = (directory: string) => (file: string) =>
      path.resolve(directory, expandHomePath(file, home));
    const invalid = () =>
      new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode configuration could not be isolated for blind evaluation.",
      });
    const readConfig = (filePath: string) =>
      fs.readFileString(filePath).pipe(
        Effect.catchIf(
          (cause) => cause.reason._tag === "NotFound",
          () => Effect.succeed("{}"),
        ),
        Effect.flatMap((content) => {
          const config = readRoutingConfig(content, resolveFile(path.dirname(filePath)));
          return config === undefined ? Effect.fail(invalid()) : Effect.succeed(config);
        }),
        Effect.mapError((cause) => (isTextGenerationError(cause) ? cause : invalid())),
      );

    let routing: Config = {};
    const configuredDirectory = input.environment.OPENCODE_CONFIG_DIR
      ? path.resolve(input.directory, expandHomePath(input.environment.OPENCODE_CONFIG_DIR, home))
      : undefined;
    const configHome = input.environment.XDG_CONFIG_HOME;
    // 2.x replaces the global directory; 1.x loads this directory after the explicit config file.
    const globalDirectory =
      input.generation === "v2" && configuredDirectory !== undefined
        ? configuredDirectory
        : configHome !== undefined && configHome.trim().length > 0
          ? path.join(configHome, "opencode")
          : path.join(home, ".config", "opencode");
    const configNames = ["opencode.json", "opencode.jsonc"];
    for (const name of [...(input.generation === "v1" ? ["config.json"] : []), ...configNames]) {
      routing = mergeConfig(routing, yield* readConfig(path.join(globalDirectory, name)));
    }
    if (input.environment.OPENCODE_CONFIG) {
      const configuredPath = path.resolve(
        input.directory,
        expandHomePath(input.environment.OPENCODE_CONFIG, home),
      );
      routing = mergeConfig(routing, yield* readConfig(configuredPath));
    }
    if (input.generation === "v1" && configuredDirectory !== undefined) {
      for (const name of configNames) {
        routing = mergeConfig(routing, yield* readConfig(path.join(configuredDirectory, name)));
      }
    }
    if (input.environment.OPENCODE_CONFIG_CONTENT) {
      const content = readRoutingConfig(
        input.environment.OPENCODE_CONFIG_CONTENT,
        resolveFile(input.directory),
      );
      if (content === undefined) return yield* invalid();
      routing = mergeConfig(routing, content);
    }

    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-evaluation-" });
    const xdgConfigHome = path.join(temporary, "xdg-config");
    const configDirectory = path.join(temporary, "config");
    yield* fs.makeDirectory(xdgConfigHome, { recursive: true });
    yield* fs.makeDirectory(configDirectory, { recursive: true });
    const {
      OPENCODE_CONFIG: _config,
      OPENCODE_CONFIG_DIR: _configDirectory,
      OPENCODE_PERMISSION: _permission,
      XDG_CONFIG_HOME: _xdgConfigHome,
      ...preserved
    } = input.environment;
    return {
      ...preserved,
      HOME: temporary,
      ...(input.environment.USERPROFILE === undefined ? {} : { USERPROFILE: temporary }),
      XDG_DATA_HOME: input.environment.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(temporary, "state"),
      XDG_CACHE_HOME: path.join(temporary, "cache"),
      XDG_CONFIG_HOME: xdgConfigHome,
      OPENCODE_CONFIG_DIR: configDirectory,
      OPENCODE_CONFIG_CONTENT: encodeConfig(routing),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    } satisfies NodeJS.ProcessEnv;
  },
  (effect) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: "generateModelEvaluation",
              detail: "OpenCode configuration could not be isolated for blind evaluation.",
              cause,
            }),
      ),
    ),
);

export const validateBlindEvaluationSelection = (
  modelSelection: ModelSelection,
  operation: TextGenerationOperation,
) => {
  const unsupported = modelSelection.options?.find(
    (option, index) => option.id !== "variant" || typeof option.value !== "string" || index > 0,
  );
  return unsupported === undefined
    ? Effect.void
    : Effect.fail(
        new TextGenerationError({
          operation,
          detail: `OpenCode blind evaluation does not support the '${unsupported.id}' model option.`,
        }),
      );
};

export const hasBlindEvaluationPartActivity = (parts: ReadonlyArray<unknown>) =>
  parts.some(
    (part) =>
      part === null ||
      typeof part !== "object" ||
      !("type" in part) ||
      !["text", "reasoning", "step-start", "step-finish", "snapshot"].includes(String(part.type)),
  );
