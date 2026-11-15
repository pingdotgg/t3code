import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { parse, stringify, type TomlTable } from "smol-toml";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  type CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  codexExecLaunchArgs,
  codexMcpListLaunchArgs,
  resolveCodexLaunchArgs,
} from "../provider/codexLaunchArgs.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toJsonSchemaObject,
} from "@t3tools/provider-core/server/textGenerationUtils";
import {
  codexModelFamily,
  getModelSelectionStringOptionValue,
  readCustomModelEntries,
} from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const CODEX_TIMEOUT_MS = 180_000;
const CODEX_MCP_LIST_TIMEOUT_MS = 10_000;
// Plugins/apps add MCP servers; use trailing config overrides because --disable loses to user -c flags.
const CODEX_NO_PLUGIN_ARGS = [
  "--config",
  "features.plugins=false",
  "--config",
  "features.apps=false",
] as const;
const CODEX_JUDGE_FEATURES = [
  "plugins",
  "apps",
  "shell_tool",
  "unified_exec",
  "hooks",
  "multi_agent",
  "multi_agent_v2",
  "view_image",
  "image_generation",
  "browser_use",
  "computer_use",
  "skill_search",
  "tool_suggest",
  "sleep_tool",
  "code_mode",
  "code_mode_host",
  "artifact",
  "memories",
  "goals",
  "default_mode_request_user_input",
  "in_app_browser",
  "in_app_local_automation",
  "workspace_dependencies",
] as const;
const CODEX_ROUTING_KEYS = new Set([
  "model_provider",
  "oss_provider",
  "model_providers",
  "openai_base_url",
  "chatgpt_base_url",
  "cli_auth_credentials_store",
  "forced_login_method",
  "forced_chatgpt_workspace_id",
]);

const routingConfig = (table: TomlTable): TomlTable =>
  Object.fromEntries(Object.entries(table).filter(([key]) => CODEX_ROUTING_KEYS.has(key)));

const isTomlTable = (value: unknown): value is TomlTable =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);

const mergeRoutingConfig = (base: TomlTable, override: TomlTable): TomlTable => {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const previous = result[key];
    result[key] =
      isTomlTable(previous) && isTomlTable(value) ? mergeRoutingConfig(previous, value) : value;
  }
  return result;
};

const CodexMcpServers = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
);
const decodeCodexMcpServers = Schema.decodeEffect(CodexMcpServers);

// mcp_servers={} merges instead of replacing; disable named entries and quote dotted names.
const codexMcpServersOff = (names: ReadonlyArray<string>): string | null =>
  names.length === 0
    ? null
    : `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`;
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
  resolveRuntime?: Effect.Effect<
    import("../provider/CodexManagedRuntime.ts").CodexEffectiveRuntime,
    import("@t3tools/contracts").ProviderSetupError,
    Scope.Scope
  >,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
  const resolvedEnvironment = environment ?? process.env;

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const removeTempFileDir = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(path.dirname(filePath), { recursive: true }).pipe(Effect.ignore);

  // Background fibers may inherit closed scopes that immediately reap temp files; write unscoped.
  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError> =>
    fileSystem
      .makeTempFile({
        prefix: `t3code-${prefix}-${process.pid}-`,
      })
      .pipe(
        Effect.tap((filePath) =>
          fileSystem
            .writeFileString(filePath, content)
            .pipe(Effect.onError(() => removeTempFileDir(filePath))),
        ),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to write temp file`,
              cause,
            }),
        ),
      );

  const encodeJsonForOperation = (
    operation: TextGenerationOperations.Operation,
    value: unknown,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to encode structured output schema.",
            cause,
          }),
      ),
    );

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    attachments: TextGenerationOperations.Request<Schema.Top>["attachments"],
  ) {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem.stat(resolvedPath).pipe(Effect.orElseSucceed(() => null));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return imagePaths;
  });

  const listEnabledMcpServers = Effect.fn("listEnabledMcpServers")(
    function* (input: {
      readonly binary: string;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly launchArgs: ReadonlyArray<string>;
    }) {
      const spawnCommand = yield* resolveSpawnCommand(
        input.binary,
        [...input.launchArgs, ...CODEX_NO_PLUGIN_ARGS, "mcp", "list", "--json"],
        { env: input.env },
      );
      const child = yield* commandSpawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: input.env,
          cwd: input.cwd,
          shell: spawnCommand.shell,
          forceKillAfter: "1 second",
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        yield* Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
          reason: "exit",
          exitCode,
        });
        return [];
      }
      const servers = yield* decodeCodexMcpServers(stdout).pipe(
        Effect.tapError(() =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "decode",
          }),
        ),
      );
      return servers.filter((server) => server.enabled).map((server) => server.name);
    },
    Effect.scoped,
    Effect.timeoutOption(CODEX_MCP_LIST_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "timeout",
          }).pipe(Effect.as<ReadonlyArray<string>>([])),
        onSome: (names) => Effect.succeed(names),
      }),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const evaluationConfiguration = Effect.fn("CodexTextGeneration.evaluationConfiguration")(
    function* (homePath: string, launchArgs: string) {
      const invalid = (cause: unknown) =>
        new TextGenerationError({
          operation: "generateModelEvaluation",
          detail: "Failed to isolate the Codex evaluator configuration.",
          cause,
        });
      const parseConfig = (source: string) =>
        Effect.try({ try: () => parse(source), catch: invalid });
      const readConfig = Effect.fn("CodexTextGeneration.readRouting")(function* (name: string) {
        const filePath = path.join(homePath, name);
        if (!(yield* fileSystem.exists(filePath))) return {};
        return yield* parseConfig(yield* fileSystem.readFileString(filePath));
      });
      const original = yield* readConfig("config.toml");
      const args = tokenizeCliArgs(launchArgs);
      const overrides: TomlTable[] = [];
      const switches: string[] = [];
      let profile = typeof original.profile === "string" ? original.profile : undefined;
      for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--profile" || arg === "-p") profile = args[++index];
        else if (arg?.startsWith("--profile=") || arg?.startsWith("-p="))
          profile = arg.slice(arg.indexOf("=") + 1);
        else if (
          arg === "--config" ||
          arg === "-c" ||
          arg?.startsWith("--config=") ||
          arg?.startsWith("-c=")
        ) {
          const value =
            arg === "--config" || arg === "-c" ? args[++index] : arg.slice(arg.indexOf("=") + 1);
          const separator = value?.indexOf("=") ?? -1;
          if (value && CODEX_ROUTING_KEYS.has(value.split(/[.=]/)[0]?.trim() ?? "")) {
            const override = yield* parseConfig(value).pipe(
              // Codex treats a CLI value that is not TOML as an unquoted string.
              Effect.catch((cause) =>
                separator < 0
                  ? Effect.fail(cause)
                  : parseConfig(
                      `${value.slice(0, separator).trim()}=${JSON.stringify(
                        value
                          .slice(separator + 1)
                          .trim()
                          .replace(/^["']+|["']+$/g, ""),
                      )}`,
                    ),
              ),
            );
            overrides.push(routingConfig(override));
          }
        } else if (arg === "--oss") switches.push(arg);
        else if (arg === "--local-provider" && args[index + 1]) switches.push(arg, args[++index]!);
        else if (arg?.startsWith("--local-provider=")) switches.push(arg);
      }
      const profileRouting =
        profile !== undefined && isTomlTable(original.profiles)
          ? original.profiles[profile]
          : undefined;
      const routing = [
        routingConfig(original),
        ...(isTomlTable(profileRouting) ? [routingConfig(profileRouting)] : []),
        ...(profile === undefined
          ? []
          : [routingConfig(yield* readConfig(`${profile}.config.toml`))]),
        ...overrides,
      ].reduce(mergeRoutingConfig, {});
      if (
        routing.cli_auth_credentials_store !== undefined &&
        routing.cli_auth_credentials_store !== "file"
      ) {
        return yield* new TextGenerationError({
          operation: "generateModelEvaluation",
          detail:
            "Codex blind evaluation requires file-backed login or a model API. Keyring login cannot be isolated.",
        });
      }
      const source = yield* Effect.try({ try: () => stringify(routing), catch: invalid });
      return {
        source,
        args: [
          ...switches,
          "--ignore-rules",
          "--json",
          "--config",
          "project_doc_max_bytes=0",
          "--config",
          "tools.experimental_request_user_input.enabled=false",
          "--config",
          "tools.update_plan.enabled=false",
          "--config",
          "skills.include_instructions=false",
          "--config",
          "features.skip_host_skill_discovery=true",
          "--config",
          'web_search="disabled"',
          ...CODEX_JUDGE_FEATURES.flatMap((feature) => ["--config", `features.${feature}=false`]),
        ],
      };
    },
  );

  const isolatedEvaluatorHome = Effect.fn("CodexTextGeneration.isolatedEvaluatorHome")(function* (
    originalHome: string,
    operation: TextGenerationOperations.Operation,
    configuration: string,
  ) {
    const evaluationHome = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-codex-evaluator-" })
      .pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to create the Codex evaluator home.",
              cause,
            }),
        ),
      );
    yield* fileSystem
      .writeFileString(path.join(evaluationHome, "config.toml"), configuration, { mode: 0o600 })
      .pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to prepare the Codex evaluator configuration.",
              cause,
            }),
        ),
      );
    const prepare = Effect.gen(function* () {
      if (yield* fileSystem.exists(path.join(originalHome, "auth.json"))) {
        // Codex follows credential links on atomic refresh; the lock must share the same identity.
        for (const name of ["auth.json", "auth.lock"]) {
          yield* fileSystem.symlink(path.join(originalHome, name), path.join(evaluationHome, name));
        }
      }
      const cache = path.join(originalHome, "models_cache.json");
      if (yield* fileSystem.exists(cache))
        yield* fileSystem.copyFile(cache, path.join(evaluationHome, "models_cache.json"));
    });
    yield* prepare.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to prepare the Codex evaluator login.",
            cause,
          }),
      ),
    );
    return evaluationHome;
  });

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    attachments,
    investigate,
  }: TextGenerationOperations.Request<S>): Effect.fn.Return<
    S["Type"],
    TextGenerationError,
    S["DecodingServices"]
  > {
    const imagePaths = yield* materializeImageAttachments(attachments);
    const schemaJson = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
    );
    const schemaPath = yield* writeTempFile(operation, "codex-schema", schemaJson);
    const outputPath = yield* writeTempFile(operation, "codex-output", "").pipe(
      Effect.onError(() => removeTempFileDir(schemaPath)),
    );

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      const resolved = resolveRuntime
        ? yield* resolveRuntime.pipe(
            Effect.mapError(
              (cause) => new TextGenerationError({ operation, detail: cause.detail }),
            ),
          )
        : undefined;
      const effectiveConfig = resolved?.config ?? codexConfig;
      const effectiveEnvironment = resolved?.environment ?? resolvedEnvironment;
      const models = yield* getModels;
      const requestedModel = modelSelection.model;
      const listed = models.filter((candidate) => !candidate.isCustom);
      // An unlisted slug is one this account can't run, e.g. gpt-6-luna on a ChatGPT login.
      const requestedFamily = codexModelFamily(requestedModel);
      const matchedModel =
        models.find((candidate) => candidate.slug === requestedModel)?.slug ??
        // Managed snapshots omit configured custom models; send those as requested.
        readCustomModelEntries(codexConfig.customModels).find(
          (entry) => entry.slug === requestedModel,
        )?.slug ??
        listed.find((candidate) => codexModelFamily(candidate.slug) === requestedFamily)?.slug;
      const model =
        operation === "generateModelEvaluation"
          ? requestedModel
          : (matchedModel ??
            listed.find((candidate) => candidate.isDefault)?.slug ??
            listed.find((candidate) => !candidate.isLegacy)?.slug ??
            listed[0]?.slug ??
            requestedModel);
      // The selection's options were chosen for the requested model and may not fit a fallback.
      const fellBack = matchedModel === undefined && model !== requestedModel;
      const launchArgs = resolveCodexLaunchArgs(effectiveConfig.launchArgs, effectiveEnvironment);
      const reasoningEffort =
        (fellBack
          ? undefined
          : getModelSelectionStringOptionValue(modelSelection, "reasoningEffort")) ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
      const serviceTier =
        (effectiveConfig.setupMode === "managed" && operation !== "generateModelEvaluation") ||
        fellBack
          ? undefined
          : getCodexServiceTierOptionValue(modelSelection);
      const binary = effectiveConfig.binaryPath || "codex";
      const env = {
        ...effectiveEnvironment,
        ...(effectiveConfig.homePath
          ? {
              CODEX_HOME: expandHomePath(
                effectiveConfig.homePath,
                yield* HostProcess.HomeDirectory,
              ),
            }
          : {}),
      };
      const originalHome = env.CODEX_HOME ?? path.join(yield* HostProcess.HomeDirectory, ".codex");
      const judgeConfiguration =
        operation === "generateModelEvaluation"
          ? yield* evaluationConfiguration(originalHome, launchArgs).pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation,
                    detail: "Failed to isolate the Codex evaluator configuration.",
                    cause,
                  }),
              ),
            )
          : undefined;
      const mcpServersOff = judgeConfiguration
        ? null
        : yield* listEnabledMcpServers({
            binary,
            cwd,
            env,
            launchArgs: codexMcpListLaunchArgs(launchArgs),
          }).pipe(Effect.map(codexMcpServersOff));
      if (judgeConfiguration)
        env.CODEX_HOME = yield* isolatedEvaluatorHome(
          originalHome,
          operation,
          judgeConfiguration.source,
        );
      const spawnCommand = yield* resolveSpawnCommand(
        binary,
        [
          "exec",
          ...(judgeConfiguration?.args ?? codexExecLaunchArgs(launchArgs)),
          // A user's MCP server could act on the text-generation prompt.
          ...CODEX_NO_PLUGIN_ARGS,
          // Memory candidates cite the supplied exchange; checkout instructions add unrelated input.
          ...(operation === "generateKnowledgeCandidates"
            ? ["--config", "project_doc_max_bytes=0"]
            : []),
          ...(mcpServersOff ? ["--config", mcpServersOff] : []),
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "--model",
          model,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
          ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        { env: effectiveEnvironment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        cwd,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
        forceKillAfter: "1 second",
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
      if (judgeConfiguration) {
        const events = yield* Effect.try({
          try: () =>
            stdout
              .split("\n")
              .filter((line) => line.trim().length > 0)
              .map((line) => JSON.parse(line) as unknown),
          catch: (cause) =>
            new TextGenerationError({
              operation,
              detail: "Codex returned invalid evaluation events.",
              cause,
            }),
        });
        for (const event of events) {
          if (event !== null && typeof event === "object" && "item" in event) {
            const item = event.item;
            if (
              item === null ||
              typeof item !== "object" ||
              !("type" in item) ||
              !["agent_message", "reasoning", "error"].includes(String(item.type))
            ) {
              return yield* new TextGenerationError({
                operation,
                detail: "Codex evaluator attempted tool activity.",
              });
            }
          }
        }
      }
    });

    const cleanup = Effect.all([removeTempFileDir(schemaPath), removeTempFileDir(outputPath)], {
      concurrency: "unbounded",
    }).pipe(Effect.asVoid);

    return yield* Effect.gen(function* () {
      yield* runCodexCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(investigate?.timeoutMs ?? CODEX_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const decodeOutput = Schema.decodeEffect(
        Schema.fromJsonString(outputSchemaJson),
        operation === "generateModelEvaluation" ? { onExcessProperty: "error" } : undefined,
      );

      return yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.flatMap(decodeOutput),
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Codex returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(Effect.ensuring(cleanup));
  });

  return TextGenerationOperations.fromRunner("CodexTextGeneration", runCodexJson, {
    supportsInvestigation: true,
    supportsBlindEvaluation: true,
  });
});
