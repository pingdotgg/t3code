import {
  ClaudeSettings,
  OrchestrationGetWorkflowScriptError,
  OrchestrationWorkflowFileError,
  type OrchestrationV2GetWorkflowScriptInput,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as Settings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { readContainedWorkflowFile } from "./workflowFileRead.ts";

/** Reads a Claude workflow script from any configured Claude home, contained to its projects root. */
export class WorkflowScriptQuery extends Context.Service<
  WorkflowScriptQuery,
  {
    readonly readWorkflowScript: (input: OrchestrationV2GetWorkflowScriptInput) => Effect.Effect<
      {
        readonly scriptPath: string;
        readonly contents: string;
        readonly truncated: boolean;
      },
      OrchestrationGetWorkflowScriptError
    >;
  }
>()("t3/orchestration-v2/workflowScriptQuery") {}

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const threads = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const secrets = yield* SecretResolver.SecretResolver;

  const readFailed = (scriptPath: string) => (cause: unknown) =>
    new OrchestrationGetWorkflowScriptError({ reason: "read-failed", scriptPath, cause });

  const threadCwd = Effect.fn("WorkflowScriptQuery.threadCwd")(function* (
    input: OrchestrationV2GetWorkflowScriptInput,
  ) {
    const { thread } = yield* threads
      .getThreadRecords(input.threadId, [])
      .pipe(Effect.mapError(readFailed(input.scriptPath)));
    if (thread.worktreePath !== null) return thread.worktreePath;
    const project = yield* projects
      .get(thread.projectId)
      .pipe(Effect.mapError(readFailed(input.scriptPath)));
    if (Option.isNone(project)) {
      return yield* new OrchestrationGetWorkflowScriptError({
        reason: "root-unavailable",
        scriptPath: input.scriptPath,
      });
    }
    return project.value.workspaceRoot;
  });

  // The running provider sees a secret-backed CLAUDE_CONFIG_DIR; disabled instances never read theirs.
  const resolveConfigDirSecret = Effect.fn("WorkflowScriptQuery.resolveConfigDirSecret")(function* (
    instance: ProviderInstanceConfig,
  ) {
    const variables = instance.environment ?? [];
    if (instance.enabled === false) return variables;
    return yield* Effect.forEach(variables, (variable) =>
      typeof variable.value === "string" || variable.name !== "CLAUDE_CONFIG_DIR"
        ? Effect.succeed(variable)
        : secrets
            .read([variable.value])
            .pipe(
              Effect.map(([value]) => (value === undefined ? variable : { ...variable, value })),
            ),
    );
  });

  const claudeConfigDirs = Effect.fn("WorkflowScriptQuery.claudeConfigDirs")(function* (
    cwd: string,
  ) {
    const instances = deriveProviderInstanceConfigMap(yield* settings.getSettings);
    const roots = new Set<string>();
    for (const instance of Object.values(instances)) {
      if (instance.driver !== "claudeAgent") continue;
      const config = decodeClaudeSettings(instance.config ?? {});
      if (Option.isNone(config)) continue;
      const env = yield* mergeProviderInstanceEnvironment(
        yield* resolveConfigDirSecret(instance),
        environment,
      );
      const inherited = env.CLAUDE_CONFIG_DIR?.trim() ?? "";
      // Claude Code resolves an inherited relative CLAUDE_CONFIG_DIR against its session cwd.
      roots.add(
        config.value.homePath.trim().length === 0 && inherited.length > 0
          ? path.resolve(cwd, inherited)
          : yield* resolveClaudeHomePath(config.value, env),
      );
    }
    return roots;
  });

  const readFromRoots = Effect.fn("WorkflowScriptQuery.readFromRoots")(function* (
    scriptPath: string,
    roots: ReadonlySet<string>,
  ) {
    let unavailable: OrchestrationWorkflowFileError | undefined;
    for (const configDir of roots) {
      const result = yield* readContainedWorkflowFile({
        path: scriptPath,
        extension: ".js",
        byteCap: 256 * 1024,
        configDir,
      }).pipe(Effect.result);
      if (result._tag === "Success") return result.success;
      if (
        result.failure.reason !== "outside-root" &&
        result.failure.reason !== "root-unavailable"
      ) {
        return yield* result.failure;
      }
      if (unavailable?.reason !== "outside-root") unavailable = result.failure;
    }
    return yield* (
      unavailable ??
        new OrchestrationWorkflowFileError({ reason: "root-unavailable", path: scriptPath })
    );
  });

  const readWorkflowScript = Effect.fn("WorkflowScriptQuery.readWorkflowScript")(
    function* (input: OrchestrationV2GetWorkflowScriptInput) {
      const cwd = yield* threadCwd(input);
      const roots = yield* claudeConfigDirs(cwd).pipe(
        Effect.mapError(readFailed(input.scriptPath)),
      );
      const file = yield* readFromRoots(input.scriptPath, roots).pipe(
        Effect.mapError(
          (error) =>
            new OrchestrationGetWorkflowScriptError({
              reason: error.reason === "wrong-extension" ? "not-js" : error.reason,
              scriptPath: error.path,
              cause: error,
            }),
        ),
      );
      return { scriptPath: file.path, contents: file.contents, truncated: file.truncated };
    },
    Effect.provideService(Path.Path, path),
    Effect.provideService(HostProcess.HomeDirectory, home),
  );

  return WorkflowScriptQuery.of({ readWorkflowScript });
});

export const layer = Layer.effect(WorkflowScriptQuery, make);
