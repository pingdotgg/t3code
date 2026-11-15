import {
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  isProviderAccountTransferError,
  type ProviderAccountImportResult,
  type ProviderAccountOmission,
  type ProviderDriverKind,
  type ProviderInstanceId,
  ProviderSetupError,
  type ServerProvider,
  type ServerSettings,
  ServerSettingsError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { Atom } from "effect/reactivity";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  EnvironmentRpcUnavailableError,
  getInitialServerConfig,
  requestGuarded,
} from "../rpc/client.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { resolveProviderInstanceDisplayName } from "./providerInstanceDisplay.ts";
import {
  type AtomCommand,
  createAtomCommandScheduler,
  createRuntimeCommand,
  withEnvironmentRpcPermissions,
} from "./runtime.ts";

export interface ProviderAccountSyncRequest {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly destinationEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

export type EnvironmentBlockReason =
  | "same-environment"
  | "not-connected"
  | "update-required"
  | "permission-required";

export type AccountSyncBlockReason = EnvironmentBlockReason | "instance-id-conflict";

interface CellKey {
  readonly instanceId: ProviderInstanceId;
  readonly destinationEnvironmentId: EnvironmentId;
}

export type ProviderAccountSyncCell = CellKey &
  (
    | {
        readonly status: "synced";
        readonly change: ProviderAccountImportResult["change"];
        readonly omitted: ReadonlyArray<ProviderAccountOmission>;
      }
    | {
        readonly status: "skipped";
        readonly end: "source" | "destination";
        readonly reason: EnvironmentBlockReason;
      }
    | {
        readonly status: "failed";
        readonly stage: "export" | "import";
        /** Safe text from the typed error. */
        readonly message: string;
      }
  );

/** One cell per (instanceId x destination), in request order. */
export interface ProviderAccountSyncReport {
  readonly cells: ReadonlyArray<ProviderAccountSyncCell>;
}

type ServerConfigCapabilities = {
  readonly environment: {
    readonly capabilities: Pick<ExecutionEnvironmentCapabilities, "providerAccountTransfer">;
  };
} | null;

const serverSupportsAccountTransfer = (config: ServerConfigCapabilities): boolean =>
  config?.environment.capabilities.providerAccountTransfer === true;

export function supportsProviderAccountSync(environment: {
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: ServerConfigCapabilities;
}): boolean {
  return (
    environment.connection.phase === "connected" &&
    serverSupportsAccountTransfer(environment.serverConfig)
  );
}

const ACCOUNT_CONCURRENCY = 4;
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isUnavailable = Schema.is(EnvironmentRpcUnavailableError);
const isNotRegistered = Schema.is(EnvironmentRegistry.EnvironmentNotRegisteredError);
const isSetupError = Schema.is(ProviderSetupError);
const isSettingsError = Schema.is(ServerSettingsError);

function cellFromFailure(
  key: CellKey,
  stage: "export" | "import",
  cause: Cause.Cause<unknown>,
): ProviderAccountSyncCell {
  const end = stage === "export" ? "source" : "destination";
  // The remote side dropped the request, e.g. its server restarted mid-call. Cancelling the
  // command interrupts this fiber itself, so it never reaches here.
  if (Cause.hasInterruptsOnly(cause))
    return {
      ...key,
      status: "failed",
      stage,
      message: `The connection to the ${end} device was interrupted. Sync again.`,
    };
  const error = Cause.squash(cause);
  if (isAuthorizationError(error))
    return { ...key, status: "skipped", end, reason: "permission-required" };
  if (isUnavailable(error) || isNotRegistered(error))
    return { ...key, status: "skipped", end, reason: "not-connected" };
  if (isProviderAccountTransferError(error) || isSetupError(error) || isSettingsError(error))
    return { ...key, status: "failed", stage, message: error.message };
  return { ...key, status: "failed", stage, message: "Couldn't sync this account. Try again." };
}

// A failed decode echoes the payload, and the payload is plaintext.
const untraced = Effect.withTracerEnabled(false);

const syncAccounts = Effect.fn("providerAccountSync.syncAccounts")(function* (
  request: ProviderAccountSyncRequest,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const source = request.sourceEnvironmentId;
  const destinations = [...new Set(request.destinationEnvironmentIds)];

  const gate = (environmentId: EnvironmentId) =>
    registry.run(environmentId, getInitialServerConfig()).pipe(
      Effect.map((config): EnvironmentBlockReason | null =>
        serverSupportsAccountTransfer(config) ? null : "update-required",
      ),
      Effect.orElseSucceed((): EnvironmentBlockReason | null => "not-connected"),
    );
  const sourceBlock = yield* gate(source);
  const destinationBlocks = new Map(
    yield* Effect.forEach(
      destinations,
      (id) =>
        id === source
          ? Effect.succeed([id, "same-environment"] as const)
          : gate(id).pipe(Effect.map((block) => [id, block] as const)),
      { concurrency: "unbounded" },
    ),
  );

  const syncAccount = Effect.fn("providerAccountSync.syncAccount")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const key = (destinationEnvironmentId: EnvironmentId): CellKey => ({
      instanceId,
      destinationEnvironmentId,
    });
    const cells = new Map<EnvironmentId, ProviderAccountSyncCell>();
    for (const id of destinations) {
      const reason = destinationBlocks.get(id) ?? null;
      if (reason !== null)
        cells.set(id, { ...key(id), status: "skipped", end: "destination", reason });
      else if (sourceBlock !== null)
        cells.set(id, { ...key(id), status: "skipped", end: "source", reason: sourceBlock });
    }
    const open = destinations.filter((id) => !cells.has(id));
    if (open.length > 0) {
      const exported = yield* Effect.exit(
        registry.run(
          source,
          requestGuarded(WS_METHODS.providerAccountExport, { instanceId }).pipe(untraced),
        ),
      );
      if (Exit.isFailure(exported)) {
        for (const id of open) cells.set(id, cellFromFailure(key(id), "export", exported.cause));
      } else {
        const account = exported.value;
        yield* Effect.forEach(
          open,
          (id) =>
            Effect.exit(
              registry.run(
                id,
                requestGuarded(WS_METHODS.providerAccountImport, { account }).pipe(untraced),
              ),
            ).pipe(
              Effect.map((exit) => {
                cells.set(
                  id,
                  Exit.isSuccess(exit)
                    ? {
                        ...key(id),
                        status: "synced",
                        change: exit.value.change,
                        omitted: exit.value.omitted,
                      }
                    : cellFromFailure(key(id), "import", exit.cause),
                );
              }),
            ),
          { concurrency: "unbounded", discard: true },
        );
      }
    }
    return destinations.flatMap((id) => {
      const cell = cells.get(id);
      return cell === undefined ? [] : [cell];
    });
  });

  const rows = yield* Effect.forEach(request.instanceIds, syncAccount, {
    concurrency: ACCOUNT_CONCURRENCY,
  });
  return { cells: rows.flat() } satisfies ProviderAccountSyncReport;
});

export function createProviderAccountSyncCommand<E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry, E>,
): AtomCommand<ProviderAccountSyncRequest, ProviderAccountSyncReport, E> & {
  readonly canExportAtom: (environmentId: EnvironmentId | null) => Atom.Atom<boolean>;
  readonly canImportAtom: (environmentId: EnvironmentId | null) => Atom.Atom<boolean>;
} {
  const exportPermissions = createCommandPermissions(runtime, WS_METHODS.providerAccountExport);
  const importPermissions = createCommandPermissions(runtime, WS_METHODS.providerAccountImport);
  const command = createRuntimeCommand(runtime, {
    label: "environment-data:provider:account-sync",
    scheduler: createAtomCommandScheduler(),
    concurrency: {
      mode: "singleFlight",
      key: (request: ProviderAccountSyncRequest) =>
        JSON.stringify([
          request.sourceEnvironmentId,
          [...request.instanceIds].sort(),
          [...request.destinationEnvironmentIds].sort(),
        ]),
    },
    execute: (request, atomRegistry) =>
      syncAccounts(request).pipe(withEnvironmentRpcPermissions(runtime, atomRegistry)),
  });
  return {
    ...command,
    canExportAtom: (environmentId) => exportPermissions.permissionAtom(environmentId),
    canImportAtom: (environmentId) => importPermissions.permissionAtom(environmentId),
  };
}

export type AccountSyncProvider = Pick<
  ServerProvider,
  "instanceId" | "driver" | "displayName" | "auth"
>;

export interface AccountSyncEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: ServerConfigCapabilities;
  readonly canManageProviders: boolean;
  /** The loaded (redacted) settings, or null while loading. Never a default fallback. */
  readonly settings: Pick<ServerSettings, "providerInstances"> | null;
  readonly providers: ReadonlyArray<AccountSyncProvider>;
}

export interface ProviderAccountSyncPlan {
  readonly sourceBlock: EnvironmentBlockReason | null;
  readonly accounts: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly label: string;
    readonly signedInAs: string | undefined;
  }>;
  readonly destinations: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly block: EnvironmentBlockReason | null;
  }>;
  readonly cells: ReadonlyArray<
    CellKey &
      (
        | { readonly action: "create" }
        | { readonly action: "update"; readonly signedInAs: string | undefined }
        | { readonly action: "blocked"; readonly reason: AccountSyncBlockReason }
      )
  >;
}

const signedInAs = (provider: Pick<ServerProvider, "auth"> | undefined): string | undefined =>
  provider?.auth.status === "authenticated"
    ? (provider.auth.email ?? provider.auth.label)
    : undefined;

function environmentBlock(environment: AccountSyncEnvironment): EnvironmentBlockReason | null {
  if (environment.connection.phase !== "connected") return "not-connected";
  if (!serverSupportsAccountTransfer(environment.serverConfig)) return "update-required";
  if (!environment.canManageProviders) return "permission-required";
  return null;
}

const driverOf = (
  environment: AccountSyncEnvironment,
  instanceId: ProviderInstanceId,
): ProviderDriverKind | undefined =>
  environment.settings?.providerInstances[instanceId]?.driver ??
  environment.providers.find((provider) => provider.instanceId === instanceId)?.driver;

/** Display only; the command and the servers re-check everything. */
export function planProviderAccountSync(input: {
  readonly source: AccountSyncEnvironment;
  readonly destinations: ReadonlyArray<AccountSyncEnvironment>;
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
}): ProviderAccountSyncPlan {
  const { source, destinations, instanceIds } = input;
  const sourceBlock = environmentBlock(source);
  const configured = source.settings?.providerInstances ?? {};
  const accounts = source.providers
    .filter(
      (provider) => provider.instanceId in configured || provider.auth.status === "authenticated",
    )
    .map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      label: resolveProviderInstanceDisplayName(provider),
      signedInAs: signedInAs(provider),
    }));
  const destinationBlock = (destination: AccountSyncEnvironment) =>
    destination.environmentId === source.environmentId
      ? "same-environment"
      : environmentBlock(destination);
  const cells = instanceIds.flatMap((instanceId) =>
    destinations.map((destination): ProviderAccountSyncPlan["cells"][number] => {
      const key = { instanceId, destinationEnvironmentId: destination.environmentId };
      const block = destinationBlock(destination) ?? sourceBlock;
      if (block !== null) return { ...key, action: "blocked", reason: block };
      const existing = driverOf(destination, instanceId);
      if (existing === undefined) return { ...key, action: "create" };
      const sourceDriver = driverOf(source, instanceId);
      if (sourceDriver !== undefined && existing !== sourceDriver)
        return { ...key, action: "blocked", reason: "instance-id-conflict" };
      return {
        ...key,
        action: "update",
        signedInAs: signedInAs(
          destination.providers.find((provider) => provider.instanceId === instanceId),
        ),
      };
    }),
  );
  return {
    sourceBlock,
    accounts,
    destinations: destinations.map((destination) => ({
      environmentId: destination.environmentId,
      label: destination.label,
      block: destinationBlock(destination),
    })),
    cells,
  };
}

export type SyncedAccountState =
  | { readonly kind: "starting" }
  | { readonly kind: "ready"; readonly signedInAs: string | undefined }
  | { readonly kind: "disabled" }
  | { readonly kind: "error"; readonly message: string | undefined }
  | { readonly kind: "needs-sign-in" }
  | { readonly kind: "needs-host-setup"; readonly documentationUrl: string | undefined };

/**
 * Read from the destination, never predicted from the source: its `auth` and `setup` already
 * describe the sign-in mode on that machine.
 */
export function syncedAccountState(
  provider:
    | Pick<
        ServerProvider,
        "driver" | "installed" | "enabled" | "status" | "message" | "auth" | "setup"
      >
    | undefined,
): SyncedAccountState {
  if (provider === undefined) return { kind: "starting" };
  if (!provider.enabled) return { kind: "disabled" };
  if (provider.status === "error") return { kind: "error", message: provider.message };
  if (provider.auth.status === "authenticated")
    return { kind: "ready", signedInAs: signedInAs(provider) };
  if (hasInAppProviderSetup(provider)) return { kind: "needs-sign-in" };
  return { kind: "needs-host-setup", documentationUrl: provider.setup?.documentationUrl };
}

function hasInAppProviderSetup(
  provider: Pick<ServerProvider, "driver" | "installed" | "setup">,
): boolean {
  return (
    provider.setup?.canAuthenticate === true ||
    provider.setup?.canInstall === true ||
    (provider.driver === "acpRegistry" && provider.installed)
  );
}
