import { EnvironmentId, type DesktopConnectAccountState } from "@t3tools/contracts";
import { create } from "zustand";
import { getPrimaryKnownEnvironment } from "../primary";
import { useSavedEnvironmentRegistryStore, type SavedEnvironmentRecord } from "./catalog";

export const useDesktopConnectAccount = create<{
  account: DesktopConnectAccountState | null;
  error: string | null;
  busy: boolean;
}>(() => ({ account: null, error: null, busy: false }));

let revision = 0;
let refreshing: Promise<void> | null = null;

function replaceAccountRecords(records: readonly SavedEnvironmentRecord[]) {
  useSavedEnvironmentRegistryStore.setState((state) => ({
    byId: {
      ...Object.fromEntries(
        Object.values(state.byId)
          .filter((record) => !record.accountId)
          .map((record) => [record.environmentId, record]),
      ),
      ...Object.fromEntries(records.map((record) => [record.environmentId, record])),
    },
  }));
}

function clearAccount() {
  revision++;
  replaceAccountRecords([]);
  useDesktopConnectAccount.setState({ account: null, error: null });
}

export function refreshDesktopConnectAccount(): Promise<void> {
  const bridge = window.desktopBridge?.connectAccount;
  if (!bridge) return Promise.resolve();
  if (refreshing) return refreshing;
  const epoch = revision;
  refreshing = (async () => {
    try {
      const account = await bridge.discover();
      if (epoch !== revision) return;
      const primaryId = getPrimaryKnownEnvironment()?.environmentId;
      const existing = useSavedEnvironmentRegistryStore.getState().byId;
      const records: SavedEnvironmentRecord[] = [];
      const errors: string[] = [];
      await Promise.all(
        (account?.environments ?? []).map(async (environment) => {
          const environmentId = EnvironmentId.make(environment.environmentId);
          if (
            environmentId === primaryId ||
            (existing[environmentId] && !existing[environmentId]?.accountId)
          )
            return;
          try {
            if (!account) return;
            const target = await bridge.connect(account.accountId, environmentId);
            records.push({
              ...target,
              environmentId,
              accountId: account.accountId,
              label: environment.label,
              createdAt: existing[environmentId]?.createdAt ?? new Date().toISOString(),
              lastConnectedAt: existing[environmentId]?.lastConnectedAt ?? null,
            });
          } catch {
            errors.push(environment.label);
            const previous = existing[environmentId];
            if (previous && previous.accountId === account?.accountId) records.push(previous);
          }
        }),
      );
      if (epoch !== revision) return;
      replaceAccountRecords(records);
      useDesktopConnectAccount.setState({
        account,
        error: errors.length
          ? `Could not connect to ${errors.join(", ")}. Retrying automatically.`
          : null,
      });
    } catch {
      if (epoch === revision) {
        useDesktopConnectAccount.setState({
          error: "Could not refresh T3 Connect. Check your connection or sign in again.",
        });
      }
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function signInDesktopConnectAccount() {
  const bridge = window.desktopBridge?.connectAccount;
  if (!bridge) return;
  useDesktopConnectAccount.setState({ busy: true, error: null });
  try {
    await bridge.login();
    await refreshing;
    await refreshDesktopConnectAccount();
  } catch {
    useDesktopConnectAccount.setState({ error: "T3 Connect sign-in did not complete. Try again." });
  } finally {
    useDesktopConnectAccount.setState({ busy: false });
  }
}

export async function signOutDesktopConnectAccount() {
  clearAccount();
  useDesktopConnectAccount.setState({ busy: true });
  try {
    await window.desktopBridge?.connectAccount?.logout();
  } catch {
    useDesktopConnectAccount.setState({
      error: "Could not remove the desktop sign-in. Try signing out again.",
    });
  } finally {
    useDesktopConnectAccount.setState({ busy: false });
  }
}

export function startDesktopConnectDiscovery() {
  if (typeof window === "undefined") return () => undefined;
  const bridge = window.desktopBridge?.connectAccount;
  if (!bridge) return () => undefined;
  let active = true;
  const unsubscribe = bridge.onInvalidated(() => {
    clearAccount();
    void (refreshing ?? Promise.resolve()).then(() => {
      if (active) void refreshDesktopConnectAccount();
    });
  });
  void refreshDesktopConnectAccount();
  const timer = window.setInterval(() => {
    void refreshDesktopConnectAccount();
  }, 30_000);
  return () => {
    active = false;
    revision++;
    window.clearInterval(timer);
    unsubscribe();
  };
}
