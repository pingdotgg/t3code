import { getKnownEnvironmentHttpBaseUrl } from "@t3tools/client-runtime";
import type {
  AuthSessionRole,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  PersistedSavedEnvironmentRecord,
  ServerConfig,
} from "@t3tools/contracts";
import { create } from "zustand";

import { ensureLocalApi } from "../../localApi";
import { reportClientError } from "../../lib/clientLogger";
import { getPrimaryKnownEnvironment } from "../primary";

export interface SavedEnvironmentRecord {
  readonly accountId?: string;
  readonly enabled?: boolean;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly createdAt: string;
  readonly lastConnectedAt: string | null;
}

interface SavedEnvironmentRegistryState {
  readonly byId: Record<EnvironmentId, SavedEnvironmentRecord>;
}

interface SavedEnvironmentRegistryStore extends SavedEnvironmentRegistryState {
  readonly upsert: (record: SavedEnvironmentRecord) => void;
  readonly remove: (environmentId: EnvironmentId) => void;
  readonly markConnected: (environmentId: EnvironmentId, connectedAt: string) => void;
  readonly reset: () => void;
}

let savedEnvironmentRegistryHydrated = false;
let savedEnvironmentRegistryHydrationPromise: Promise<void> | null = null;
let registryWrite: Promise<void> = Promise.resolve();

function enqueueRegistryWrite(write: () => Promise<void>): Promise<void> {
  const result = registryWrite.then(write);
  registryWrite = result.catch(() => undefined);
  return result;
}

function toPersistedSavedEnvironmentRecord(
  record: SavedEnvironmentRecord,
): PersistedSavedEnvironmentRecord {
  return {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
    ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
  };
}

function valuesOfSavedEnvironmentRegistry(
  byId: Record<EnvironmentId, SavedEnvironmentRecord>,
): ReadonlyArray<SavedEnvironmentRecord> {
  return Object.values(byId).filter((record) => record.accountId === undefined);
}

function persistSavedEnvironmentRegistryState(): void {
  void enqueueRegistryWrite(async () => {
    await ensureLocalApi().persistence.setSavedEnvironmentRegistry(
      valuesOfSavedEnvironmentRegistry(useSavedEnvironmentRegistryStore.getState().byId).map(
        toPersistedSavedEnvironmentRecord,
      ),
    );
  }).catch((error) => {
    reportClientError("[SAVED_ENVIRONMENTS] persist failed", error);
  });
}

export function persistSavedEnvironmentEnabled(
  environmentId: EnvironmentId,
  enabled: boolean,
): Promise<void> {
  return enqueueRegistryWrite(async () => {
    const { byId } = useSavedEnvironmentRegistryStore.getState();
    const record = byId[environmentId];
    if (!record) throw new Error("Saved environment not found.");
    await ensureLocalApi().persistence.setSavedEnvironmentRegistry(
      valuesOfSavedEnvironmentRegistry({ ...byId, [environmentId]: { ...record, enabled } }).map(
        toPersistedSavedEnvironmentRecord,
      ),
    );
    useSavedEnvironmentRegistryStore.setState((state) => {
      const current = state.byId[environmentId];
      if (!current) return state;
      return { byId: { ...state.byId, [environmentId]: { ...current, enabled } } };
    });
  });
}

function replaceSavedEnvironmentRegistryState(
  records: ReadonlyArray<SavedEnvironmentRecord>,
): void {
  const currentById = useSavedEnvironmentRegistryStore.getState().byId;
  const hydratedById = Object.fromEntries(records.map((record) => [record.environmentId, record]));
  useSavedEnvironmentRegistryStore.setState({
    byId: {
      ...hydratedById,
      ...currentById,
    },
  });
}

async function hydrateSavedEnvironmentRegistry(): Promise<void> {
  if (savedEnvironmentRegistryHydrated) {
    return;
  }
  if (savedEnvironmentRegistryHydrationPromise) {
    return savedEnvironmentRegistryHydrationPromise;
  }

  const nextHydration = (async () => {
    try {
      const persistedRecords = await ensureLocalApi().persistence.getSavedEnvironmentRegistry();
      replaceSavedEnvironmentRegistryState(persistedRecords);
    } catch (error) {
      reportClientError("[SAVED_ENVIRONMENTS] hydrate failed", error);
    } finally {
      savedEnvironmentRegistryHydrated = true;
    }
  })();

  const hydrationPromise = nextHydration.finally(() => {
    if (savedEnvironmentRegistryHydrationPromise === hydrationPromise) {
      savedEnvironmentRegistryHydrationPromise = null;
    }
  });
  savedEnvironmentRegistryHydrationPromise = hydrationPromise;

  return savedEnvironmentRegistryHydrationPromise;
}

export const useSavedEnvironmentRegistryStore = create<SavedEnvironmentRegistryStore>()((set) => ({
  byId: {},
  upsert: (record) =>
    set((state) => {
      const byId = {
        ...state.byId,
        [record.environmentId]: record,
      };
      persistSavedEnvironmentRegistryState();
      return { byId };
    }),
  remove: (environmentId) =>
    set((state) => {
      const { [environmentId]: _removed, ...remaining } = state.byId;
      persistSavedEnvironmentRegistryState();
      return {
        byId: remaining,
      };
    }),
  markConnected: (environmentId, connectedAt) =>
    set((state) => {
      const existing = state.byId[environmentId];
      if (!existing) {
        return state;
      }
      const byId = {
        ...state.byId,
        [environmentId]: {
          ...existing,
          lastConnectedAt: connectedAt,
        },
      };
      persistSavedEnvironmentRegistryState();
      return { byId };
    }),
  reset: () => {
    persistSavedEnvironmentRegistryState();
    set({
      byId: {},
    });
  },
}));

export function hasSavedEnvironmentRegistryHydrated(): boolean {
  return savedEnvironmentRegistryHydrated;
}

export function waitForSavedEnvironmentRegistryHydration(): Promise<void> {
  if (hasSavedEnvironmentRegistryHydrated()) {
    return Promise.resolve();
  }

  return hydrateSavedEnvironmentRegistry();
}

export function listSavedEnvironmentRecords(): ReadonlyArray<SavedEnvironmentRecord> {
  return Object.values(useSavedEnvironmentRegistryStore.getState().byId).toSorted((left, right) =>
    left.label.localeCompare(right.label),
  );
}

export function getSavedEnvironmentRecord(
  environmentId: EnvironmentId,
): SavedEnvironmentRecord | null {
  return useSavedEnvironmentRegistryStore.getState().byId[environmentId] ?? null;
}

export function getEnvironmentHttpBaseUrl(environmentId: EnvironmentId): string | null {
  const primaryEnvironment = getPrimaryKnownEnvironment();
  if (primaryEnvironment?.environmentId === environmentId) {
    return getKnownEnvironmentHttpBaseUrl(primaryEnvironment);
  }

  return getSavedEnvironmentRecord(environmentId)?.httpBaseUrl ?? null;
}

export function resolveEnvironmentHttpUrl(input: {
  readonly environmentId: EnvironmentId;
  readonly pathname: string;
  readonly searchParams?: Record<string, string>;
}): string {
  const httpBaseUrl = getEnvironmentHttpBaseUrl(input.environmentId);
  if (!httpBaseUrl) {
    throw new Error(`Unable to resolve HTTP base URL for environment ${input.environmentId}.`);
  }

  const url = new URL(httpBaseUrl);
  url.pathname = input.pathname;
  if (input.searchParams) {
    url.search = new URLSearchParams(input.searchParams).toString();
  }
  return url.toString();
}

export function resetSavedEnvironmentRegistryStoreForTests() {
  savedEnvironmentRegistryHydrated = false;
  savedEnvironmentRegistryHydrationPromise = null;
  useSavedEnvironmentRegistryStore.setState({ byId: {} });
}

export async function persistSavedEnvironmentRecord(record: SavedEnvironmentRecord): Promise<void> {
  await enqueueRegistryWrite(async () => {
    const byId = {
      ...useSavedEnvironmentRegistryStore.getState().byId,
      [record.environmentId]: record,
    };
    await ensureLocalApi().persistence.setSavedEnvironmentRegistry(
      valuesOfSavedEnvironmentRegistry(byId).map(toPersistedSavedEnvironmentRecord),
    );
  });
}

export async function readSavedEnvironmentBearerToken(
  environmentId: EnvironmentId,
): Promise<string | null> {
  if (getSavedEnvironmentRecord(environmentId)?.accountId) return null;
  return ensureLocalApi().persistence.getSavedEnvironmentSecret(environmentId);
}

export async function writeSavedEnvironmentBearerToken(
  environmentId: EnvironmentId,
  bearerToken: string,
): Promise<boolean> {
  return ensureLocalApi().persistence.setSavedEnvironmentSecret(environmentId, bearerToken);
}

export async function removeSavedEnvironmentBearerToken(
  environmentId: EnvironmentId,
): Promise<void> {
  await ensureLocalApi().persistence.removeSavedEnvironmentSecret(environmentId);
}

export type SavedEnvironmentConnectionState = "connecting" | "connected" | "disconnected" | "error";

export type SavedEnvironmentAuthState = "authenticated" | "requires-auth" | "unknown";

export interface SavedEnvironmentRuntimeState {
  readonly connectionState: SavedEnvironmentConnectionState;
  readonly authState: SavedEnvironmentAuthState;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly role: AuthSessionRole | null;
  readonly descriptor: ExecutionEnvironmentDescriptor | null;
  readonly serverConfig: ServerConfig | null;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
}

interface SavedEnvironmentRuntimeStoreState {
  readonly byId: Record<EnvironmentId, SavedEnvironmentRuntimeState>;
  readonly ensure: (environmentId: EnvironmentId) => void;
  readonly patch: (
    environmentId: EnvironmentId,
    patch: Partial<SavedEnvironmentRuntimeState>,
  ) => void;
  readonly clear: (environmentId: EnvironmentId) => void;
  readonly reset: () => void;
}

const DEFAULT_SAVED_ENVIRONMENT_RUNTIME_STATE: SavedEnvironmentRuntimeState = Object.freeze({
  connectionState: "disconnected",
  authState: "unknown",
  lastError: null,
  lastErrorAt: null,
  role: null,
  descriptor: null,
  serverConfig: null,
  connectedAt: null,
  disconnectedAt: null,
});

function createDefaultSavedEnvironmentRuntimeState(): SavedEnvironmentRuntimeState {
  return {
    ...DEFAULT_SAVED_ENVIRONMENT_RUNTIME_STATE,
  };
}

export const useSavedEnvironmentRuntimeStore = create<SavedEnvironmentRuntimeStoreState>()(
  (set) => ({
    byId: {},
    ensure: (environmentId) =>
      set((state) => {
        if (state.byId[environmentId]) {
          return state;
        }
        return {
          byId: {
            ...state.byId,
            [environmentId]: createDefaultSavedEnvironmentRuntimeState(),
          },
        };
      }),
    patch: (environmentId, patch) =>
      set((state) => ({
        byId: {
          ...state.byId,
          [environmentId]: {
            ...(state.byId[environmentId] ?? createDefaultSavedEnvironmentRuntimeState()),
            ...patch,
          },
        },
      })),
    clear: (environmentId) =>
      set((state) => {
        const { [environmentId]: _removed, ...remaining } = state.byId;
        return {
          byId: remaining,
        };
      }),
    reset: () =>
      set({
        byId: {},
      }),
  }),
);

export function getSavedEnvironmentRuntimeState(
  environmentId: EnvironmentId,
): SavedEnvironmentRuntimeState {
  return (
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId] ??
    DEFAULT_SAVED_ENVIRONMENT_RUNTIME_STATE
  );
}

export function resetSavedEnvironmentRuntimeStoreForTests() {
  useSavedEnvironmentRuntimeStore.getState().reset();
}
