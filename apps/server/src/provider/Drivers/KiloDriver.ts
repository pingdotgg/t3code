import { KiloSettings, type ServerProvider } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as KiloTextGeneration from "../../textGeneration/KiloTextGeneration.ts";
import * as ServerConfig from "../../config.ts";
import * as KiloAdapter from "../../orchestration-v2/Adapters/KiloAdapterV2.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as KiloRuntime from "../kilo/KiloRuntime.ts";
import { ProviderDriverError } from "../Errors.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const isRuntimeError = Schema.is(KiloRuntime.KiloRuntimeError);

const decode = Schema.decodeSync(KiloSettings);
const kind = KiloAdapter.KILO_PROVIDER;
const systemKeys = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

export type KiloDriverEnv =
  | Exclude<Effect.Services<ReturnType<typeof KiloRuntime.make>>, Scope.Scope>
  | IdAllocator.IdAllocatorV2
  | ServerConfig.ServerConfig;

export const KiloDriver: ProviderDriver<KiloSettings, KiloDriverEnv> = {
  driverKind: kind,
  metadata: { displayName: "Kilo", supportsMultipleInstances: true },
  configSchema: KiloSettings,
  defaultConfig: () => decode({}),
  create: Effect.fn("KiloDriver.create")(function* (input) {
    const server = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const host = yield* HostProcessEnvironment;
    // Only explicit per-instance variables may select provider credentials/config.
    const environment: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(host).filter(([key]) => systemKeys.has(key)),
    );
    for (const variable of input.environment) environment[variable.name] = variable.value;
    const profileDirectory =
      input.config.profileDirectory ||
      path.join(
        server.stateDir,
        "providers",
        "kilo",
        input.instanceId,
        encodeURIComponent(input.config.accountId),
      );
    const authContent = yield* KiloRuntime.readAuth(profileDirectory, environment).pipe(
      Effect.mapError(
        () =>
          new ProviderDriverError({
            driver: kind,
            instanceId: input.instanceId,
            detail:
              "Could not read the selected Kilo credentials. Check the profile and reload the provider.",
          }),
      ),
    );
    const identity = [
      path.resolve(profileDirectory),
      input.config.accountId,
      authContent,
      ...input.environment
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((entry) => `${entry.name}=${entry.value}`),
    ].join("\0");
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(identity)).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: kind,
            instanceId: input.instanceId,
            detail: "Could not establish Kilo account identity.",
            cause,
          }),
      ),
    );
    const continuationKey = `kilo:${input.instanceId}:${Encoding.encodeHex(digest)}`;
    const runtime = yield* KiloRuntime.make({
      instanceId: continuationKey,
      binaryPath: input.config.binaryPath,
      profileDirectory,
      processStateDirectory: server.stateDir,
      environment,
      authContent,
    }).pipe(
      Effect.mapError(
        () =>
          new ProviderDriverError({
            driver: kind,
            instanceId: input.instanceId,
            detail: "Could not prepare the selected Kilo credentials.",
          }),
      ),
    );
    const orchestrationAdapter = yield* KiloAdapter.make({
      instanceId: input.instanceId,
      continuationKey,
      cwd: server.cwd,
      attachmentsDir: server.attachmentsDir,
      runtime,
    });
    const changes = yield* PubSub.unbounded<ServerProvider>();
    const mutex = yield* Semaphore.make(1);
    const stamp = (snapshot: ReturnType<typeof buildServerProvider>): ServerProvider => ({
      ...snapshot,
      instanceId: input.instanceId,
      driver: kind,
      displayName: input.displayName ?? "Kilo",
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      continuation: { groupKey: continuationKey },
    });
    let latest = stamp(
      buildServerProvider({
        driver: kind,
        presentation: {
          displayName: "Kilo",
          badgeLabel: "Preview",
          supportsConversationRollback: true,
          supportedRuntimeModes: ["full-access", "approval-required"],
        },
        enabled: input.enabled,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown", profileId: input.config.accountId },
          message:
            "Checking Kilo. Native configuration and MCP servers are trusted; tool approvals are not a sandbox.",
        },
      }),
    );
    const refresh = mutex.withPermit(
      Effect.gen(function* () {
        if (!input.enabled) return latest;
        const check = Effect.gen(function* () {
          const connection = yield* runtime.open(server.cwd);
          const inventory = yield* connection.client.models();
          const agents = (yield* connection.client.agents()).filter(
            (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
          );
          const models = inventory.all
            .filter((provider) => inventory.connected.includes(provider.id))
            .flatMap((provider) =>
              Object.values(provider.models).map((model) => ({
                slug: `${provider.id}/${model.id}`,
                name: model.name,
                subProvider: provider.name,
                isCustom: false,
                capabilities: {
                  optionDescriptors: [
                    ...(Object.keys(model.variants ?? {}).length
                      ? [
                          {
                            id: "variant",
                            label: "Reasoning",
                            type: "select" as const,
                            options: Object.keys(model.variants ?? {}).map((variant) => ({
                              id: variant,
                              label: variant,
                            })),
                          },
                        ]
                      : []),
                    ...(agents.length
                      ? [
                          {
                            id: "agent",
                            label: "Agent",
                            type: "select" as const,
                            options: agents.map((agent) => ({
                              id: agent.name,
                              label: agent.displayName ?? agent.name,
                              ...(agent.name === "build" ? { isDefault: true } : {}),
                            })),
                          },
                        ]
                      : []),
                  ],
                },
              })),
            );
          return stamp(
            buildServerProvider({
              driver: kind,
              presentation: {
                displayName: "Kilo",
                badgeLabel: "Preview",
                supportsConversationRollback: true,
                supportedRuntimeModes: ["full-access", "approval-required"],
              },
              enabled: input.enabled,
              checkedAt: DateTime.formatIso(yield* DateTime.now),
              models,
              probe: {
                installed: true,
                version: connection.client.version,
                status: models.length ? "ready" : "warning",
                auth: {
                  status: "unknown",
                  profileId: input.config.accountId,
                },
                ...(models.length
                  ? {
                      message:
                        "Kilo is ready. Native configuration and MCP servers are trusted; tool approvals are not a sandbox. Model authentication has not been prompt-tested. Subagents require Full access.",
                    }
                  : {
                      message: `No connected models in the Kilo account profile ${profileDirectory}. Configure this profile with Kilo or set explicit provider environment variables.`,
                    }),
              },
            }),
          );
        }).pipe(Effect.scoped);
        latest = yield* check.pipe(
          Effect.catch((cause) =>
            Effect.succeed({
              ...latest,
              status: "error" as const,
              installed: false,
              message: isRuntimeError(cause)
                ? cause.message
                : "Could not refresh Kilo. Check the binary, account profile and native configuration.",
            }),
          ),
        );
        yield* PubSub.publish(changes, latest);
        return latest;
      }),
    );
    if (input.enabled) yield* refresh.pipe(Effect.forkScoped);
    const textGeneration = KiloTextGeneration.make(runtime, server.attachmentsDir);
    return {
      instanceId: input.instanceId,
      driverKind: kind,
      displayName: input.displayName,
      accentColor: input.accentColor,
      enabled: input.enabled,
      continuationIdentity: { driverKind: kind, continuationKey },
      orchestrationAdapter,
      textGeneration,
      snapshot: {
        getSnapshot: Effect.sync(() => latest),
        refresh,
        streamChanges: Stream.fromPubSub(changes),
        applyUsageLimits: () => Effect.void,
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: kind,
              packageName: "@kilocode/cli",
            }),
          ),
      },
    };
  }),
};
