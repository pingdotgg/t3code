import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as Equal from "effect/Equal";

export interface OrderedProviderSettingsRow {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly isDirty?: boolean;
}

const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const CURSOR_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(CURSOR_DRIVER);

export function deriveVisibleProviderDriverOrder(input: {
  readonly driverOrder: ReadonlyArray<ProviderDriverKind>;
  readonly serverProviders: ReadonlyArray<Pick<ServerProvider, "instanceId">>;
}): ReadonlyArray<ProviderDriverKind> {
  const cursorIsVisible = input.serverProviders.some(
    (provider) => provider.instanceId === CURSOR_DEFAULT_INSTANCE_ID,
  );
  return input.driverOrder.filter((driver) => driver !== CURSOR_DRIVER || cursorIsVisible);
}

export function deriveOrderedProviderSettingsRows(input: {
  readonly settings: Pick<ServerSettings, "providerInstances" | "providers">;
  readonly driverOrder: ReadonlyArray<ProviderDriverKind>;
}): ReadonlyArray<OrderedProviderSettingsRow> {
  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(input.settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>(
    input.driverOrder.map((driver) => String(defaultInstanceIdForDriver(driver))),
  );
  const knownDrivers = new Set(input.driverOrder);
  const rows: OrderedProviderSettingsRow[] = [];
  type LegacyProviderSettings =
    (typeof input.settings.providers)[keyof typeof input.settings.providers];
  const legacyProviders = input.settings.providers as Record<string, LegacyProviderSettings>;
  const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings
  >;

  for (const driver of input.driverOrder) {
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = input.settings.providerInstances?.[defaultInstanceId];
    const legacyConfig = legacyProviders[driver];
    const defaultLegacyConfig = defaultLegacyProviders[driver];
    const effectiveInstance: ProviderInstanceConfig | undefined =
      explicitInstance ??
      (legacyConfig !== undefined
        ? ({
            driver,
            enabled: legacyConfig.enabled,
            config: legacyConfig,
          } satisfies ProviderInstanceConfig)
        : undefined);

    if (effectiveInstance !== undefined) {
      rows.push({
        instanceId: defaultInstanceId,
        instance: effectiveInstance,
        driver,
        isDefault: true,
        isDirty: explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig),
      });
    }
    for (const [id, instance] of instancesByDriver.get(driver) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }

  for (const [driver, list] of instancesByDriver) {
    if (knownDrivers.has(driver)) continue;
    for (const [id, instance] of list) {
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: defaultSlotIdsBySource.has(String(id)),
      });
    }
  }

  return rows;
}

export function deriveVisibleOrderedProviderSettingsRows(input: {
  readonly settings: Pick<ServerSettings, "providerInstances" | "providers">;
  readonly driverOrder: ReadonlyArray<ProviderDriverKind>;
  readonly serverProviders: ReadonlyArray<Pick<ServerProvider, "instanceId">>;
}): ReadonlyArray<OrderedProviderSettingsRow> {
  const visibleDriverOrder = deriveVisibleProviderDriverOrder(input);
  const visibleDrivers = new Set(visibleDriverOrder);
  const hiddenDrivers = new Set(input.driverOrder.filter((driver) => !visibleDrivers.has(driver)));
  const providerInstances = Object.fromEntries(
    Object.entries(input.settings.providerInstances ?? {}).filter(
      ([, instance]) => !hiddenDrivers.has(instance.driver),
    ),
  ) as Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>;
  return deriveOrderedProviderSettingsRows({
    settings: { ...input.settings, providerInstances },
    driverOrder: visibleDriverOrder,
  });
}

export interface ProviderEnvironmentOptionLike {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function buildProviderEnvironmentOptions<T extends ProviderEnvironmentOptionLike>(
  environments: ReadonlyArray<T>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<T> {
  return environments.toSorted((left, right) => {
    const leftIsPrimary = left.environmentId === primaryEnvironmentId;
    const rightIsPrimary = right.environmentId === primaryEnvironmentId;
    if (leftIsPrimary !== rightIsPrimary) {
      return leftIsPrimary ? -1 : 1;
    }
    return (
      left.label.localeCompare(right.label) ||
      String(left.environmentId).localeCompare(String(right.environmentId))
    );
  });
}

export function resolveSelectedProviderEnvironmentId(
  environments: ReadonlyArray<ProviderEnvironmentOptionLike>,
  selectedEnvironmentId: EnvironmentId | null,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  if (
    selectedEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === selectedEnvironmentId)
  ) {
    return selectedEnvironmentId;
  }
  if (
    primaryEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === primaryEnvironmentId)
  ) {
    return primaryEnvironmentId;
  }
  return environments[0]?.environmentId ?? null;
}

export type ProviderEnvironmentAccess =
  | { readonly kind: "editable" }
  /** `reason` distinguishes waiting on the device from waiting on permissions. */
  | { readonly kind: "loading"; readonly reason: "config" | "permissions" }
  | { readonly kind: "read-only" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error" };

/**
 * Whether the session may change provider configuration on an environment.
 * `pending` means the answer is still unknown, which must not be presented as
 * editable: rendering controls we already know might be rejected only turns a
 * permission problem into a failed write.
 */
export type ProviderOperateAccess = "granted" | "denied" | "pending";

/**
 * Resolve operate access from an environment's `/api/auth/session` answer.
 *
 * Cached session data wins over an in-flight revalidation. The session atoms
 * are SWR-backed, so they report `isPending` on every background refresh;
 * treating that as unknown would flip a working panel back to loading and
 * discard in-progress edits.
 *
 * `missingScopesAccess` decides the case where the session resolved but did
 * not report scopes: the primary serves the web app itself so its server
 * always reports them (absence means denial), while a remote device may run an
 * older server version that predates scope reporting, where denial would lock
 * out a legitimate session. The environment RPC layer stays authoritative
 * either way.
 */
function resolveSessionOperateAccess(input: {
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly missingScopesAccess: "granted" | "denied";
}): ProviderOperateAccess {
  if (input.session === null) {
    if (input.isPending) {
      return "pending";
    }
    // A failed session fetch is a transport problem, not a permission
    // decision — locking the panel read-only would misreport it. Stay
    // optimistic; the environment RPC layer still rejects unauthorized writes.
    return input.hasError ? "granted" : "denied";
  }
  if (!input.session.authenticated) {
    return "denied";
  }
  if (input.session.scopes === undefined) {
    return input.missingScopesAccess;
  }
  return input.session.scopes.includes(AuthOrchestrationOperateScope) ? "granted" : "denied";
}

/** Operate access for the primary environment's own browser session. */
export function resolvePrimaryOperateAccess(input: {
  readonly isPrimary: boolean;
  readonly hasDesktopBridge: boolean;
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ProviderOperateAccess {
  if (!input.isPrimary || input.hasDesktopBridge) {
    return "granted";
  }
  return resolveSessionOperateAccess({
    session: input.session,
    isPending: input.isPending,
    hasError: input.hasError,
    missingScopesAccess: "denied",
  });
}

/**
 * Operate access for a non-primary environment, derived from the scopes its
 * `/api/auth/session` endpoint reports for this client's credential.
 */
export function resolveRemoteOperateAccess(input: {
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ProviderOperateAccess {
  return resolveSessionOperateAccess({
    ...input,
    missingScopesAccess: "granted",
  });
}

export function classifyProviderEnvironmentAccess(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
  readonly operateAccess: ProviderOperateAccess;
}): ProviderEnvironmentAccess {
  if (input.connectionPhase === "error") {
    return { kind: "error" };
  }
  if (input.connectionPhase !== "connected") {
    return { kind: "unavailable" };
  }
  if (!input.hasServerConfig) {
    return { kind: "loading", reason: "config" };
  }
  if (input.operateAccess === "pending") {
    return { kind: "loading", reason: "permissions" };
  }
  if (input.operateAccess === "denied") {
    return { kind: "read-only" };
  }
  return { kind: "editable" };
}
