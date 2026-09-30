import type {
  ConnectAccountDriver,
  DesktopConnectDiscovery,
  DesktopConnectTarget,
} from "@t3tools/shared/desktopConnect";

export type { ConnectAccountDriver } from "@t3tools/shared/desktopConnect";

export function createConnectAccountBroker(driver: ConnectAccountDriver) {
  let generation = 0;
  let discovery: DesktopConnectDiscovery | null = null;
  const targets = new Map<string, Promise<DesktopConnectTarget>>();
  const listeners = new Set<() => void>();
  let pendingDiscovery: Promise<DesktopConnectDiscovery | null> | undefined;

  const invalidate = () => {
    generation++;
    targets.clear();
    discovery = null;
    for (const listener of listeners) listener();
  };
  const assertCurrent = (epoch: number, accountId: string) => {
    if (epoch !== generation || discovery?.accountId !== accountId) {
      throw new Error("T3 Connect account changed. Reconnect using the current account.");
    }
  };
  const discover = () => {
    if (pendingDiscovery) return pendingDiscovery;
    const epoch = generation;
    pendingDiscovery = driver
      .discover()
      .then((next) => {
        if (epoch !== generation) return discovery;
        if (
          discovery &&
          (next?.accountId !== discovery.accountId ||
            discovery.environments.some(
              (previous) =>
                !next?.environments.some(
                  (current) => current.environmentId === previous.environmentId,
                ),
            ))
        )
          invalidate();
        discovery = next;
        return next;
      })
      .finally(() => {
        pendingDiscovery = undefined;
      });
    return pendingDiscovery;
  };

  return {
    discover,
    subscribeInvalidation(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async login() {
      invalidate();
      await driver.login();
      return discover();
    },
    async logout() {
      invalidate();
      await driver.logout();
    },
    async connect(accountId: string, environmentId: string): Promise<DesktopConnectTarget> {
      const epoch = generation;
      assertCurrent(epoch, accountId);
      let pending = targets.get(environmentId);
      if (!pending) {
        pending = driver.connect(accountId, environmentId).catch((error) => {
          if (targets.get(environmentId) === pending) targets.delete(environmentId);
          throw error;
        });
        targets.set(environmentId, pending);
      }
      const target = await pending;
      assertCurrent(epoch, accountId);
      return {
        httpBaseUrl: target.httpBaseUrl,
        async nextSocketUrl() {
          assertCurrent(epoch, accountId);
          const url = await target.nextSocketUrl();
          assertCurrent(epoch, accountId);
          return url;
        },
        async request(path, request) {
          assertCurrent(epoch, accountId);
          const response = await target.request(path, request);
          assertCurrent(epoch, accountId);
          return response;
        },
      };
    },
  };
}
