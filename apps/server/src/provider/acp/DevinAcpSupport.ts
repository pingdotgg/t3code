import {
  type DevinSettings,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type RuntimeMode,
  ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { DevinModelCatalog, devinModels, resolveDevinModel } from "./DevinModels.ts";

import { spawnAndCollect } from "../providerSnapshot.ts";
import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const encodeMcpConfig = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeMcpConnected = Schema.decodeUnknownEffect(
  Schema.Struct({ connectionStatus: Schema.Literal("connected") }),
);

/** Devin resolves MCP tools from its session roots, even after connectServer succeeds. */
export const prepareDevinMcp = Effect.fn("prepareDevinMcp")(function* (
  session: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-devin-mcp-" });
  const configDirectory = path.join(directory, ".devin");
  yield* fs.makeDirectory(configDirectory, { mode: 0o700 });
  yield* fs.writeFileString(
    path.join(configDirectory, "mcp_config.local.json"),
    encodeMcpConfig({
      mcpServers: {
        "t3-code": {
          serverUrl: session.endpoint,
          headers: { Authorization: session.authorizationHeader },
        },
      },
    }),
    { mode: 0o600 },
  );
  const connect = (runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">) =>
    runtime
      .request("_cognition.ai/mcp/connectServer", {
        serverId: "t3-code",
        workspaceDirs: [directory],
      })
      .pipe(
        Effect.flatMap(decodeMcpConnected),
        Effect.timeout("20 seconds"),
        Effect.asVoid,
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.internalError(
            "Devin could not connect to T3 Code tools.",
          ),
        ),
      );
  return { directory, connect };
});

/** Use the same executable and environment for health checks and actual sessions. */
export const runDevinCommand = Effect.fn("runDevinCommand")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const binaryPath = settings.binaryPath || "devin";
  const resolved = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
  return yield* spawnAndCollect(
    binaryPath,
    ChildProcess.make(resolved.command, resolved.args, {
      env: environment,
      shell: resolved.shell,
      ...(cwd ? { cwd } : {}),
    }),
  );
});

/** The Desktop launcher also owns `devin` on some machines, but cannot speak ACP. */
export const checkDevinExecutable = Effect.fn("checkDevinExecutable")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
) {
  const result = yield* runDevinCommand(settings, environment, ["--version"]).pipe(
    Effect.timeout("5 seconds"),
  );
  const version = /^devin\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/im.exec(result.stdout)?.[1];
  if (result.code !== 0 || !version) {
    return yield* EffectAcpErrors.AcpRequestError.invalidParams(
      "The configured command is not Devin CLI. Install Devin CLI from https://docs.devin.ai/cli or set its binary path in Settings → Providers. The Devin Desktop launcher does not support ACP.",
    );
  }
  return version;
});

const decodeDevinModelCatalog = Schema.decodeEffect(DevinModelCatalog);
const sameSelection = Schema.toEquivalence(ModelSelection);

/** This command waits for fresh account models; ACP initially returns its disk cache. */
const readDevinModelCatalog = Effect.fn("readDevinModelCatalog")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
) {
  const result = yield* runDevinCommand(settings, environment, [
    "models",
    "list",
    "--format",
    "json",
  ]);
  if (result.code !== 0) {
    return yield* EffectAcpErrors.AcpRequestError.internalError(
      "Devin CLI could not list available models. Run devin models list on this environment.",
    );
  }
  return yield* decodeDevinModelCatalog(result.stdout);
});

export const readDevinModels = (settings: DevinSettings, environment: NodeJS.ProcessEnv) =>
  readDevinModelCatalog(settings, environment).pipe(Effect.map(devinModels));

function includesModel(options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>, model: string) {
  const config = options.find((option) => option.id === "model");
  return (
    config?.type === "select" &&
    config.options.some((entry) =>
      "value" in entry
        ? entry.value === model
        : entry.options.some((option) => option.value === model),
    )
  );
}

export const makeDevinAcpRuntime = Effect.fn("makeDevinAcpRuntime")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv,
  input: Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "spawn" | "authMethodId">,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // `authenticate` starts Devin's browser flow. Ordinary launches use the credentials
  // saved by `devin auth login` or WINDSURF_API_KEY, including remote environments.
  const runtime = yield* AcpSessionRuntime.make({
    ...input,
    spawn: {
      command: settings.binaryPath || "devin",
      args: ["acp"],
      cwd: input.cwd,
      env: environment,
    },
    cancelBehavior: "wait-for-prompt",
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      _meta: { "cognition.ai/mcp": true, "cognition.ai/mcpWorkspaceDirs": true },
    },
  });
  const modelUpdates = yield* SubscriptionRef.make<
    ReadonlyArray<EffectAcpSchema.SessionConfigOption>
  >([]);
  yield* runtime.handleSessionUpdate((notification) =>
    notification.update.sessionUpdate === "config_option_update"
      ? runtime.getConfigOptions.pipe(
          Effect.flatMap((options) => SubscriptionRef.set(modelUpdates, options)),
        )
      : Effect.void,
  );
  const getCatalog = readDevinModelCatalog(settings, environment).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) => EffectAcpErrors.AcpRequestError.internalError(cause.message)),
  );
  const setModel = Effect.fn("DevinAcpRuntime.setModel")(function* (modelId: string) {
    yield* runtime.start();
    if (!includesModel(yield* runtime.getConfigOptions, modelId)) {
      // An upgrade can make the CLI catalog newer than the initial ACP config.
      // Only wait for models the account actually offers, while consuming ACP updates.
      const catalog = yield* getCatalog;
      if (
        catalog.families.some((family) =>
          family.variants.some((variant) => variant.model_uid === modelId),
        )
      ) {
        yield* SubscriptionRef.changes(modelUpdates).pipe(
          Stream.filter((options) => includesModel(options, modelId)),
          Stream.take(1),
          Stream.runDrain,
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () =>
              Effect.fail(
                EffectAcpErrors.AcpRequestError.invalidParams(
                  `Devin has not made model ${modelId} available to this session yet. Try again after refreshing provider status.`,
                ),
              ),
          }),
        );
      }
    }
    return yield* runtime.setModel(modelId);
  });
  let previousSelection: ModelSelection | undefined;
  let previousModel: string | undefined;
  return {
    ...runtime,
    setModel,
    applyModel: Effect.fn("DevinAcpRuntime.applyModel")(function* (selection?: ModelSelection) {
      const config = (yield* runtime.getConfigOptions).find((option) => option.id === "model");
      const current = config?.type === "select" ? config.currentValue : undefined;
      if (!selection) return current;
      if (
        previousSelection &&
        sameSelection(selection, previousSelection) &&
        current === previousModel
      )
        return current;
      const model = resolveDevinModel(yield* getCatalog, selection);
      if (!model)
        return yield* EffectAcpErrors.AcpRequestError.invalidParams(
          `Devin does not offer the selected thinking, speed, and context combination for ${selection.model}. Refresh provider status and choose an available combination.`,
        );
      if (model !== current) yield* setModel(model);
      previousSelection = selection;
      previousModel = model;
      return model;
    }),
  };
});

export function devinMode(
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode | undefined,
  availableModes: ReadonlyArray<{ readonly id: string }>,
): string {
  if (interactionMode === "plan") return "plan";
  switch (runtimeMode) {
    case "full-access":
      return "bypass";
    case "auto-accept-edits":
      return "accept-edits";
    case "auto":
      return availableModes.some((mode) => mode.id === "smart") ? "smart" : "normal";
    case "approval-required":
      return "normal";
  }
}

export const applyDevinMode = Effect.fn("applyDevinMode")(function* (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  sessionId: string,
  runtimeMode: RuntimeMode,
  interactionMode?: ProviderInteractionMode,
) {
  const state = yield* runtime.getModeState;
  const modeId = devinMode(runtimeMode, interactionMode, state?.availableModes ?? []);
  // Devin accepts `normal` via set_mode but omits it from its config-option choices.
  // setMode uses those choices for validation, so use the native mode request here.
  yield* runtime.request("session/set_mode", { sessionId, modeId });
});

/** Match the option kind; providers are free to choose arbitrary option IDs. */
export function selectDevinPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
) {
  const kind =
    decision === "accept"
      ? "allow_once"
      : decision === "acceptForSession" || decision === "acceptAlways"
        ? "allow_always"
        : decision === "decline"
          ? "reject_once"
          : undefined;
  return kind === undefined ? undefined : request.options.find((option) => option.kind === kind);
}
