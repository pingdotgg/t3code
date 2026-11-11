import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as Duration from "effect/Duration";
import {
  ExtensionError,
  OrchestrationV2Command,
  ServerSettingsPatch,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedNodeRuntime from "./ManagedNodeRuntime.ts";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import * as FileSystem from "effect/FileSystem";
import { extensionHostEntry } from "./hostEntry.ts";
import type { ExtensionHostLaunch } from "./ExtensionProcess.ts";
import { hostApiSchemas } from "./hostApiSchemas.ts";

const decodeThread = Schema.decodeUnknownEffect(Schema.Struct({ threadId: ThreadId }));
const decodeCommand = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2Command));
const decodeSettings = Schema.decodeUnknownEffect(Schema.toCodecJson(ServerSettingsPatch));
const encodeProjects = Schema.encodeEffect(Schema.toCodecJson(hostApiSchemas.ProjectSnapshot));
const encodeThreads = Schema.encodeEffect(Schema.toCodecJson(hostApiSchemas.ThreadShellSnapshot));
const encodeThread = Schema.encodeEffect(Schema.toCodecJson(hostApiSchemas.ThreadSnapshot));
const encodeDispatch = Schema.encodeEffect(Schema.toCodecJson(hostApiSchemas.DispatchResult));
const encodeSettings = Schema.encodeEffect(Schema.toCodecJson(hostApiSchemas.ServerSettings));

export class ExtensionHostAdapter extends Context.Service<
  ExtensionHostAdapter,
  {
    readonly installPackage: (
      source: string,
      directory: string,
      signal: AbortSignal,
    ) => Promise<void>;
    readonly launch: (signal: AbortSignal) => Promise<ExtensionHostLaunch>;
    readonly platform: NodeJS.Platform;
    readonly call: (method: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  }
>()("t3/extensions/ExtensionHostAdapter") {}

export const layer = Layer.effect(
  ExtensionHostAdapter,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const platform = yield* HostProcess.Platform;
    const environment = yield* HostProcess.Environment;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const context = yield* Effect.context<
      | ThreadManagementService.ThreadManagementService
      | ThreadLaunchService.ThreadLaunchService
      | FileSystem.FileSystem
      | ServerConfig.ServerConfig
      | ServerSettings.ServerSettingsService
      | DocumentText.DocumentText
      | ProcessRunner.ProcessRunner
      | Path.Path
      | HttpClient.HttpClient
    >();
    const call = Effect.fn("ExtensionHostAdapter.call")(
      function* (method: string, input: unknown) {
        switch (method) {
          case "projects.list":
            return yield* Effect.flatMap(projects.snapshot, encodeProjects);
          case "threads.list":
            return yield* Effect.flatMap(threads.getShellSnapshot(), encodeThreads);
          case "threads.get": {
            const { threadId } = yield* decodeThread(input);
            return yield* Effect.flatMap(threads.getThreadSnapshot(threadId), encodeThread);
          }
          case "orchestration.dispatch": {
            const command = yield* decodeCommand(input);
            return yield* (
              command.type === "prepared-run.retry"
                ? (yield* ThreadLaunchService.ThreadLaunchService).retryPreparation(command)
                : ThreadMessageIntake.dispatchCommand(command)
            ).pipe(Effect.provide(context), Effect.flatMap(encodeDispatch));
          }
          case "settings.get":
            return yield* Effect.flatMap(settings.getSettings, encodeSettings);
          case "settings.update":
            return yield* Effect.flatMap(
              settings.updateSettings(yield* decodeSettings(input)),
              encodeSettings,
            );
          default:
            return yield* new ExtensionError({
              operation: method,
              id: "host",
              reason: "not-found",
            });
        }
      },
      (effect, method) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ExtensionError({
                operation: method,
                id: "host",
                reason: "runtime-failed",
                cause,
              }),
          ),
        ),
    );
    // Node IPC is a Promise boundary; the service operations retain their application-owned context.
    return {
      launch: (signal) =>
        Effect.runPromiseWith(context)(
          Effect.gen(function* () {
            const runtime = yield* ManagedNodeRuntime.ensure(
              path.join(config.stateDir, "extensions", "runtimes"),
            );
            const worker = yield* Effect.tryPromise({
              try: () => extensionHostEntry(path.join(config.stateDir, "extensions", "hosts")),
              catch: (cause) =>
                new ExtensionError({
                  operation: "host",
                  id: "runtime",
                  reason: "runtime-failed",
                  cause,
                }),
            });
            const env = { ...environment };
            const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
            env[pathKey] =
              `${path.dirname(runtime.node)}${platform === "win32" ? ";" : ":"}${env[pathKey] ?? ""}`;
            return {
              command: runtime.node,
              args: [worker],
              env,
            };
          }),
          { signal },
        ),
      platform,
      installPackage: (source, directory, signal) =>
        Effect.runPromiseWith(context)(
          Effect.gen(function* () {
            const runtime = yield* ManagedNodeRuntime.ensure(
              path.join(config.stateDir, "extensions", "runtimes"),
            );
            const env = { ...environment };
            const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
            env[pathKey] =
              `${path.dirname(runtime.node)}${platform === "win32" ? ";" : ":"}${env[pathKey] ?? ""}`;
            const result = yield* runner.run({
              command: runtime.node,
              args: [
                runtime.npm,
                "install",
                "--prefix",
                directory,
                "--no-audit",
                "--no-fund",
                "--",
                source,
              ],
              env,
              timeout: Duration.minutes(5),
              maxOutputBytes: 256 * 1024,
              outputMode: "truncate",
            });
            if (result.code !== 0 || result.timedOut)
              return yield* new ExtensionError({
                operation: "install",
                id: source,
                reason: "install-failed",
                detail: `npm exited with ${result.code ?? "no exit code"}${result.timedOut ? " (timed out)" : ""}.`,
                cause: new Error(result.stderr || result.stdout),
              });
          }),
          { signal },
        ),
      call: (method, input, signal) =>
        Effect.runPromiseWith(context)(call(method, input), { signal }),
    };
  }),
);
