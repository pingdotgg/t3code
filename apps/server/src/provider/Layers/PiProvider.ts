import { PiSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import { mapPiDiscoveredModels } from "../pi/PiModel.ts";
import {
  makePiRpcClient,
  type PiRpcClient,
  type PiRpcError,
  type PiRpcSpawnOptions,
} from "../pi/PiRpcClient.ts";
import type { PiRpcCommand } from "../pi/PiRpcSchema.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const DETERMINISTIC_ARGS = ["--no-session", "--offline"] as const;

type PiRpcClientFactory = (
  options: PiRpcSpawnOptions,
) => Effect.Effect<PiRpcClient, PiRpcError, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>;
const models = (settings: PiSettings, discovered = mapPiDiscoveredModels([])) =>
  providerModelsFromSettings(discovered, settings.customModels, {
    optionDescriptors: [],
  });

const mapPiCommands = (commands: ReadonlyArray<PiRpcCommand>) => {
  const environmentCommands = commands.filter((command) => command.sourceInfo.scope !== "project");
  const slashCommands = environmentCommands.flatMap((command) => {
    const name = command.name.trim();
    if (!name) return [];
    const description = command.description?.trim();
    return [{ name, ...(description ? { description } : {}) }];
  });
  const skills = environmentCommands.flatMap((command) => {
    if (command.source !== "skill" || !command.name.startsWith("skill:")) return [];
    const name = command.name.slice("skill:".length).trim();
    const path = command.sourceInfo.path.trim();
    if (!name || !path) return [];
    const description = command.description?.trim();
    const scope = command.sourceInfo.scope.trim();
    return [
      {
        name,
        path,
        enabled: true,
        ...(description ? { description, shortDescription: description } : {}),
        ...(scope ? { scope } : {}),
      },
    ];
  });
  return { slashCommands, skills };
};

const isPiCommandMissingCause = (error: unknown) => {
  const seen = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    if (isCommandMissingCause(current)) return true;
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
};

export const makePendingPiProvider = (settings: PiSettings): Effect.Effect<ServerProviderDraft> =>
  DateTime.now.pipe(
    Effect.map(DateTime.formatIso),
    Effect.map((checkedAt) =>
      buildServerProvider({
        presentation: PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: models(settings),
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: settings.enabled
            ? "Pi provider status has not been checked in this session yet."
            : "Pi is disabled in T3 Code settings.",
        },
      }),
    ),
  );

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  makeRpcClient: PiRpcClientFactory = makePiRpcClient,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) return yield* makePendingPiProvider(settings);
  const discovery = yield* Effect.scoped(
    Effect.gen(function* () {
      const client = yield* makeRpcClient({
        command: settings.binaryPath,
        args: DETERMINISTIC_ARGS,
        env: environment,
      });
      return yield* Effect.all({
        inventory: client.getAvailableModels(),
        state: client.getState(),
        commands: client.getCommands(),
      });
    }),
  ).pipe(Effect.exit);
  if (discovery._tag === "Failure") {
    const error = Cause.squash(discovery.cause);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: models(settings),
      probe: {
        installed: !isPiCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi model discovery failed: ${String(error)}`,
      },
    });
  }
  const discovered = mapPiDiscoveredModels(
    discovery.value.inventory.models.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name?.trim() || model.id,
      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    })),
    discovery.value.state.model
      ? {
          provider: discovery.value.state.model.provider,
          modelId: discovery.value.state.model.id,
          ...(discovery.value.state.thinkingLevel
            ? { thinkingLevel: discovery.value.state.thinkingLevel }
            : {}),
        }
      : undefined,
  );
  const commands = mapPiCommands(discovery.value.commands.commands);
  const hasMcp = discovery.value.commands.commands.some(
    (command) => command.source === "extension" && command.name.trim() === "mcp",
  );
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models: models(settings, discovered),
    slashCommands: commands.slashCommands,
    skills: commands.skills,
    probe: {
      installed: true,
      version: null,
      status: discovered.length > 0 && hasMcp ? "ready" : "warning",
      auth: { status: discovered.length > 0 ? "authenticated" : "unknown", type: "pi" },
      message:
        discovered.length === 0
          ? "Pi is available, but it did not report any models."
          : hasMcp
            ? `Pi reported ${discovered.length} available model${discovered.length === 1 ? "" : "s"}; MCP support is available.`
            : `Pi reported ${discovered.length} available model${discovered.length === 1 ? "" : "s"}, but pi-mcp-adapter was not detected. Install it with 'pi install npm:pi-mcp-adapter'.`,
    },
  });
});
