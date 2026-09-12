import { OrchestrationCommand, OrchestrationShellSnapshot } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../os-jank.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { SERVICE_LAUNCHER_CONTEXT_ENV } from "../cloud/serviceProtocol.ts";
import { DriveMode } from "../driveMode.ts";
import { runServer } from "../server.ts";
import { resolveServerConfig, sharedServerCommandFlags, resolveCliAuthConfig } from "./config.ts";

export const DriveScenario = Schema.Struct({
  version: Schema.Literal(1),
  commands: Schema.Array(OrchestrationCommand).check(Schema.isNonEmpty()),
});

const decodeScenarioFile = Schema.decodeUnknownEffect(Schema.fromJsonString(DriveScenario));
const decodeScenario = Schema.decodeUnknownEffect(DriveScenario);

const encodeScenario = Schema.encodeEffect(fromJsonStringPretty(DriveScenario));
const encodeScenarioSummary = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      homeDir: Schema.String,
      commandCount: Schema.Int,
      snapshot: OrchestrationShellSnapshot,
    }),
  ),
);

class DriveScenarioError extends Schema.TaggedErrorClass<DriveScenarioError>()(
  "DriveScenarioError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const scenarioRuntimeLayer = OrchestrationLayerLive.pipe(
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceLayerLive),
);

const prepareScenario = Effect.fn("drive.prepareScenario")(function* (
  file: string,
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scenario = yield* decodeScenarioFile(yield* fs.readFileString(file));
  const ids = new Set<string>();
  for (const command of scenario.commands) {
    if (ids.has(command.commandId)) {
      return yield* new DriveScenarioError({
        message: `Duplicate commandId '${command.commandId}' would silently skip a command.`,
      });
    }
    ids.add(command.commandId);
  }
  const homeDir = path.resolve(yield* expandHomePath(destination));
  yield* fs.makeDirectory(path.dirname(homeDir), { recursive: true });
  // Nonrecursive mkdir is the claim: even an empty existing directory or symlink is refused.
  yield* fs.makeDirectory(homeDir).pipe(
    Effect.mapError(
      (cause) =>
        new DriveScenarioError({
          message: `Cannot create '${homeDir}'. Scenario homes must not already exist.`,
          cause,
        }),
    ),
  );

  return { scenario, homeDir };
});

export const driveScenarioCommand = Command.make("scenario", {
  file: Argument.string("file").pipe(Argument.withDescription("Version 1 scenario JSON file.")),
  homeDir: Flag.string("home-dir").pipe(
    Flag.withDescription("New, nonexistent T3 home to populate. Existing paths are refused."),
  ),
}).pipe(
  Command.withDescription(
    "Create isolated synthetic state through the event engine, without providers.",
  ),
  Command.withHandler(
    Effect.fn("driveScenario")(function* (flags) {
      const { scenario, homeDir } = yield* prepareScenario(flags.file, flags.homeDir);
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig({ baseDir: Option.some(homeDir) }, logLevel);
      const snapshot = yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const query = yield* ProjectionSnapshotQuery;
        for (const [index, command] of scenario.commands.entries()) {
          yield* engine.dispatch(command).pipe(
            Effect.mapError(
              (cause) =>
                new DriveScenarioError({
                  message: `Scenario command ${index + 1} (${command.type}) failed. Partial state remains at '${homeDir}'.`,
                  cause,
                }),
            ),
          );
        }
        return yield* query.getShellSnapshot();
      }).pipe(Effect.provide(scenarioRuntimeLayer.pipe(Layer.provide(ServerConfig.layer(config)))));
      yield* Console.log(
        yield* encodeScenarioSummary({ homeDir, commandCount: scenario.commands.length, snapshot }),
      );
    }),
  ),
);

export const driveServeCommand = Command.make("serve", {
  file: Argument.string("file"),
  homeDir: Flag.string("home-dir").pipe(
    Flag.withDescription("New, nonexistent home for the demo server."),
  ),
  port: sharedServerCommandFlags.port,
  host: sharedServerCommandFlags.host,
  devUrl: sharedServerCommandFlags.devUrl,
}).pipe(
  Command.withDescription(
    "Serve a scenario in the real client with provider reactors disabled. Uses a new home.",
  ),
  Command.withHandler(
    Effect.fn("drive.serve")(function* (flags) {
      const { scenario, homeDir } = yield* prepareScenario(flags.file, flags.homeDir);
      const config = yield* resolveServerConfig(
        {
          baseDir: Option.some(homeDir),
          port: flags.port,
          host: flags.host,
          devUrl: flags.devUrl,
          mode: Option.some("web"),
          cwd: Option.none(),
          noBrowser: Option.some(true),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(false),
          logWebSocketEvents: Option.some(false),
          tailscaleServeEnabled: Option.some(false),
          tailscaleServePort: Option.none(),
        },
        yield* GlobalFlag.LogLevel,
        { startupPresentation: "headless", forceAutoBootstrapProjectFromCwd: false },
      );
      yield* Console.error(
        "Drive demo: provider reactors are disabled. Use a normal server to verify real provider interactions.",
      );
      const environment = yield* HostProcessEnvironment;
      return yield* runServer.pipe(
        Effect.provideService(HostProcessEnvironment, {
          ...environment,
          [SERVICE_LAUNCHER_CONTEXT_ENV]: undefined,
          T3_BOOT_SERVICE_UNIT: undefined,
        }),
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(DriveMode, scenario.commands),
      );
    }),
  ),
);

export const driveExampleCommand = Command.make("example", {
  workspace: Flag.string("workspace").pipe(
    Flag.withDescription("Existing project workspace path to reference in the example."),
  ),
}).pipe(
  Command.withDescription(
    "Print an editable scenario covering empty, completed, streaming, error, and archived threads.",
  ),
  Command.withHandler(
    Effect.fn("driveExample")(function* (flags) {
      const path = yield* Path.Path;
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);
      const completedAt = DateTime.formatIso(DateTime.add(now, { milliseconds: 1 }));
      const projectId = "drive-project";
      const commands: unknown[] = [
        {
          type: "project.create",
          commandId: "drive-project-create",
          projectId,
          title: "Drive scenarios",
          workspaceRoot: path.resolve(yield* expandHomePath(flags.workspace)),
          createdAt,
        },
      ];
      for (const state of ["empty", "completed", "streaming", "error", "archived"] as const) {
        const threadId = `drive-${state}`;
        commands.push({
          type: "thread.create",
          commandId: `${threadId}-create`,
          threadId,
          projectId,
          title: `Drive: ${state}`,
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          historyImport: true,
        });
        if (state === "completed" || state === "archived") {
          commands.push({
            type: "thread.history.import",
            commandId: `${threadId}-history`,
            threadId,
            messages: [
              {
                messageId: `${threadId}-user`,
                role: "user",
                text: "Show the verification results.",
                createdAt,
              },
              {
                messageId: `${threadId}-assistant`,
                role: "assistant",
                text: "## Verification\n\nThis is synthetic scenario content.\n\n- [x] Completed state\n- [x] Markdown rendering\n\n```ts\nconst result = { status: 'ready' };\n```",
                createdAt: completedAt,
              },
            ],
          });
        }
        if (state === "streaming" || state === "error") {
          commands.push({
            type: "thread.turn.start",
            commandId: `${threadId}-start`,
            threadId,
            message: {
              messageId: `${threadId}-user`,
              role: "user",
              text: "Show the verification results.",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt,
          });
          commands.push({
            type: "thread.session.set",
            commandId: `${threadId}-session`,
            threadId,
            session: {
              threadId,
              status: state === "streaming" ? "running" : "error",
              providerName: "codex",
              providerInstanceId: "codex",
              runtimeMode: "approval-required",
              activeTurnId: state === "streaming" ? `${threadId}-turn` : null,
              lastError: state === "error" ? "Synthetic provider failure for verification." : null,
              updatedAt: createdAt,
            },
            createdAt,
          });
        }
        if (state === "streaming") {
          commands.push({
            type: "thread.message.assistant.delta",
            commandId: `${threadId}-delta`,
            threadId,
            messageId: `${threadId}-assistant`,
            turnId: `${threadId}-turn`,
            delta: "Synthetic partial response, preserved for inspecting the streaming state…",
            createdAt: completedAt,
          });
        }
        if (state === "archived") {
          commands.push({ type: "thread.archive", commandId: `${threadId}-archive`, threadId });
        }
      }
      const scenario = yield* decodeScenario({ version: 1, commands });
      yield* Console.log(yield* encodeScenario(scenario));
    }),
  ),
);
