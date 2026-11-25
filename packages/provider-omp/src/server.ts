import { isDeepStrictEqual } from "node:util";
import {
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import {
  buildServerProvider,
  spawnAndCollect,
  type ProviderProbeResult,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { OMP_RPC_PROVIDER, OmpRpcSettings } from "./settings.ts";
import { makeOmpAdapter } from "./server/adapter.ts";
import { makeOmpAuth } from "./server/auth.ts";
import { ompLocalCommands, ompRuntimeModes, readModels } from "./server/protocol.ts";
import { makeOmpSessionCatalog } from "./server/sessionCatalog.ts";
import { ompSessionCommands } from "./server/sessionCommands.ts";
import { readOmpSkillCommandsEnabled, readOmpSkills } from "./server/skills.ts";
import { makeOmpTextGeneration } from "./server/textGeneration.ts";

const driver = OMP_RPC_PROVIDER;
const decodeJsonOption = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeSync(OmpRpcSettings);
const decodeJson = (value: string) => {
  const decoded = decodeJsonOption(value);
  return decoded._tag === "Some" ? decoded.value : undefined;
};
const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
  provider: driver,
  packageName: null,
});

const create = Effect.fn("OmpRpcDriver.create")(function* (
  input: Parameters<ProviderDriver<OmpRpcSettings>["create"]>[0],
) {
  const host = yield* ProviderHost;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = yield* mergeProviderInstanceEnvironment(
    input.environment,
    yield* HostProcess.Environment,
  );
  const binaryPath = expandHomePath(input.config.binaryPath, yield* HostProcess.HomeDirectory);
  const config = { ...input.config, binaryPath, enabled: input.enabled };
  const nativeSessionCatalog = yield* makeOmpSessionCatalog({ binaryPath, environment: env });
  const continuationIdentity = defaultProviderContinuationIdentity({
    driverKind: driver,
    instanceId: input.instanceId,
  });
  const stamp = withInstanceIdentity({
    ...input,
    accentColor: input.accentColor,
    driverKind: driver,
    continuationGroupKey: continuationIdentity.continuationKey,
  });
  const settings = yield* makeProviderSnapshotSettingsSource(config);
  const auth = input.enabled
    ? yield* makeOmpAuth({
        instanceId: input.instanceId,
        binaryPath,
        environment: env,
        credentialKey: env.PI_CODING_AGENT_DIR ? `omp:${env.PI_CODING_AGENT_DIR}` : "local:omp",
        refresh: Effect.suspend((): Effect.Effect<ServerProvider> => snapshot.refresh),
      })
    : undefined;
  const probeCommand = Effect.fn("OmpRpcDriver.probeCommand")(
    function* (args: ReadonlyArray<string>, cwd = host.paths.cwd) {
      const command = yield* resolveSpawnCommand(binaryPath, args, { env });
      return yield* spawnAndCollect(
        binaryPath,
        ChildProcess.make(command.command, command.args, {
          env,
          extendEnv: false,
          shell: command.shell,
          cwd,
        }),
        { maxStdoutBytes: 8 * 1024 * 1024 },
      );
    },
    Effect.scoped,
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.timeout("10 seconds"),
  );

  const makeSnapshot = (
    probe: ProviderProbeResult,
    models: ReadonlyArray<ServerProviderModel> = [],
  ) =>
    DateTime.now.pipe(
      Effect.map((now) => {
        const catalog = new Map(models.map((model) => [model.slug, model]));
        for (const setting of config.customModels) {
          const custom = typeof setting === "string" ? { slug: setting } : setting;
          const slug = custom.slug.trim();
          if (!slug || catalog.has(slug)) continue;
          catalog.set(slug, {
            slug,
            name: custom.name ?? slug,
            isCustom: true,
            capabilities: custom.capabilities ?? null,
          });
        }
        return stamp({
          ...buildServerProvider({
            driver,
            enabled: input.enabled,
            checkedAt: DateTime.formatIso(now),
            probe,
            models: [...catalog.values()],
            slashCommands: [
              { name: "goal", description: "Create or control an Oh My Pi goal" },
              { name: "compact", description: "Compact the Oh My Pi conversation" },
              ...ompLocalCommands,
              ...ompSessionCommands,
            ],
            presentation: {
              displayName: "Oh My Pi",
              supportedRuntimeModes: ompRuntimeModes,
              showInteractionModeToggle: false,
              supportsConversationRollback: true,
            },
          }),
          auth: { ...probe.auth, canLogout: false },
          setup: { canAuthenticate: auth !== undefined && probe.installed, canInstall: false },
          ...(probe.status === "ready"
            ? {
                nativeSessions: {
                  canList: true,
                  canLoad: true,
                  canResume: true,
                  canDelete: false,
                },
              }
            : {}),
          supportsTextGeneration: input.enabled,
        });
      }),
    );
  const initial = () =>
    makeSnapshot({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
    });
  const checkProvider = Effect.gen(function* () {
    if (!input.enabled) return yield* initial();
    const output = yield* probeCommand(["--version"]).pipe(Effect.option);
    const version =
      output._tag === "Some" && output.value.code === 0
        ? /\b\d+\.\d+\.\d+(?:-[\w.-]+)?/.exec(output.value.stdout)?.[0]
        : undefined;
    if (version === undefined)
      return yield* makeSnapshot({
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi was not found. Install omp and check its binary path.",
      });
    const [major, minor] = version.split(".").map(Number);
    if ((major ?? 0) < 19 || (major === 19 && (minor ?? 0) < 1))
      return yield* makeSnapshot({
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Update Oh My Pi to 19.1 or later for native RPC and Goal support.",
      });
    const catalog = yield* probeCommand(["models", "--json", "--no-extensions"]).pipe(
      Effect.map((result) => (result.code === 0 ? readModels(decodeJson(result.stdout)) : [])),
      Effect.option,
    );
    const models = catalog._tag === "Some" ? catalog.value : [];
    return yield* makeSnapshot(
      {
        installed: true,
        version,
        status: models.length > 0 ? "ready" : "warning",
        auth: { status: models.length > 0 ? "authenticated" : "unknown" },
        ...(models.length > 0
          ? {}
          : {
              message:
                "No Oh My Pi models were discovered. Check your model configuration or run omp login.",
            }),
      },
      models,
    );
  });
  const snapshot = yield* makeManagedServerProvider({
    ...settings,
    resolveMaintenance: () => Effect.succeed(maintenance),
    haveSettingsChanged: haveProviderSnapshotSettingsChanged,
    initialSnapshot: initial,
    checkProvider,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver,
          instanceId: input.instanceId,
          detail: "Could not initialize the Oh My Pi RPC snapshot.",
          cause,
        }),
    ),
  );
  const readWorkspaceSkills = Effect.fn("OmpRpcDriver.readWorkspaceSkills")(
    function* (cwd: string) {
      const setting = yield* probeCommand(
        ["config", "get", "skills.enableSkillCommands", "--json"],
        cwd,
      );
      const enabled = setting.code === 0 ? readOmpSkillCommandsEnabled(setting.stdout) : undefined;
      if (enabled === false) return [];
      if (enabled === undefined)
        return yield* new ProviderDriverError({
          driver,
          instanceId: input.instanceId,
          detail: "Oh My Pi did not report its Skill command setting.",
        });
      const listed = yield* probeCommand(["skill", "list", "--json"], cwd);
      const skills = listed.code === 0 ? readOmpSkills(listed.stdout) : undefined;
      if (skills === undefined)
        return yield* new ProviderDriverError({
          driver,
          instanceId: input.instanceId,
          detail: "Oh My Pi did not report the workspace Skills.",
        });
      return skills;
    },
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver,
          instanceId: input.instanceId,
          detail: "Could not list Oh My Pi workspace Skills.",
          cause,
        }),
    ),
  );
  const rescans = yield* Queue.sliding<string>(128);
  const commandsByCwd = new Map<string, ReadonlyArray<ServerProviderSlashCommand>>();
  const textGeneration = yield* makeOmpTextGeneration({
    binaryPath,
    environment: env,
    enabled: input.enabled,
  });
  const orchestrationAdapter = yield* makeOmpAdapter({
    ...input,
    binaryPath,
    environment: env,
    onCommandsUpdated: (cwd, commands) =>
      Effect.suspend(() => {
        const previous = commandsByCwd.get(cwd);
        if (isDeepStrictEqual(previous, commands)) return Effect.void;
        commandsByCwd.delete(cwd);
        commandsByCwd.set(cwd, commands);
        if (commandsByCwd.size > 128) commandsByCwd.delete(commandsByCwd.keys().next().value!);
        return Queue.offer(rescans, cwd).pipe(Effect.asVoid);
      }),
  });
  return {
    instanceId: input.instanceId,
    driverKind: driver,
    displayName: input.displayName,
    accentColor: input.accentColor,
    enabled: input.enabled,
    continuationIdentity,
    snapshot,
    workspaceRescans: Stream.fromQueue(rescans),
    snapshotForCwd: (cwd: string) =>
      input.enabled
        ? Effect.all([snapshot.getSnapshot, readWorkspaceSkills(cwd)]).pipe(
            Effect.map(([current, skills]) => {
              const discoveredSkills = new Set(skills.map((skill) => `skill:${skill.name}`));
              const commands = new Map(
                current.slashCommands.map((command) => [command.name, command]),
              );
              for (const command of commandsByCwd.get(cwd) ?? []) {
                if (!discoveredSkills.has(command.name)) commands.set(command.name, command);
              }
              return {
                ...current,
                skills,
                slashCommands: [...commands.values()],
                slashCommandsPending: false,
              };
            }),
          )
        : snapshot.getSnapshot,
    orchestrationAdapter,
    ...(input.enabled ? { nativeSessionCatalog } : {}),
    ...(auth === undefined ? {} : { auth }),
    textGeneration,
  };
});

export type OmpRpcDriverEnv = Effect.Services<ReturnType<typeof create>>;
export const OmpRpcDriver: ProviderDriver<OmpRpcSettings, OmpRpcDriverEnv> = {
  driverKind: driver,
  metadata: { displayName: "Oh My Pi", supportsMultipleInstances: true },
  configSchema: OmpRpcSettings,
  defaultConfig: () => decodeSettings({}),
  create,
};
