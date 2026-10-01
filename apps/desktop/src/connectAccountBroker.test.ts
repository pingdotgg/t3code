import { describe, expect, it } from "vitest";

import { createConnectAccountBroker, type ConnectAccountDriver } from "./connectAccountBroker.ts";

describe("desktop account broker", () => {
  it("starts fresh discovery after login and retains it when old discovery finishes", async () => {
    type Discovery = Awaited<ReturnType<ConnectAccountDriver["discover"]>>;
    const oldDiscovery = Promise.withResolvers<Discovery>();
    const newDiscovery = Promise.withResolvers<Discovery>();
    let calls = 0;
    const account = { accountId: "account-a", identity: "Alice", environments: [] };
    const broker = createConnectAccountBroker({
      login: async () => undefined,
      logout: async () => undefined,
      discover: () => (++calls === 1 ? oldDiscovery.promise : newDiscovery.promise),
      connect: async () => {
        throw new Error("unused");
      },
    });
    const beforeLogin = broker.discover();
    const login = broker.login();
    await Promise.resolve();
    oldDiscovery.resolve(null);
    await beforeLogin;
    const afterLogin = broker.discover();
    newDiscovery.resolve(account);
    await expect(login).resolves.toEqual(account);
    await expect(afterLogin).resolves.toEqual(account);
    expect(calls).toBe(2);
  });

  it("does not release an authorization completed after logout", async () => {
    let complete: (() => void) | undefined;
    let signedIn = true;
    const driver: ConnectAccountDriver = {
      login: async () => undefined,
      logout: async () => {
        signedIn = false;
      },
      discover: async () =>
        signedIn ? { accountId: "account-a", identity: "Alice", environments: [] } : null,
      connect: async () => {
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
        return {
          httpBaseUrl: "https://host.example",
          nextSocketUrl: async () => "wss://host.example/ws?ticket=secret",
          request: async () => new Response("private"),
        };
      },
    };
    const broker = createConnectAccountBroker(driver);
    await broker.discover();
    const pending = broker.connect("account-a", "environment-a");
    await broker.logout();
    complete?.();
    await expect(pending).rejects.toThrow("account changed");
  });

  it("rejects stale-account requests before invoking the credential owner", async () => {
    let connectCalls = 0;
    const broker = createConnectAccountBroker({
      login: async () => undefined,
      logout: async () => undefined,
      discover: async () => ({ accountId: "account-b", identity: "Bob", environments: [] }),
      connect: async () => {
        connectCalls++;
        throw new Error("must not authorize");
      },
    });
    await broker.discover();
    await expect(broker.connect("account-a", "environment-a")).rejects.toThrow("account changed");
    expect(connectCalls).toBe(0);
  });

  it("revokes existing request capabilities when the account changes", async () => {
    let accountId = "account-a";
    let requests = 0;
    const broker = createConnectAccountBroker({
      login: async () => undefined,
      logout: async () => undefined,
      discover: async () => ({ accountId, identity: accountId, environments: [] }),
      connect: async () => ({
        httpBaseUrl: "https://host.example",
        nextSocketUrl: async () => "wss://host.example/ws?ticket=secret",
        request: async () => {
          requests++;
          return new Response("private");
        },
      }),
    });
    await broker.discover();
    const target = await broker.connect(accountId, "environment-a");
    accountId = "account-b";
    await broker.discover();
    await expect(
      target.request("/api/private", new Request("https://host.example")),
    ).rejects.toThrow("account changed");
    expect(requests).toBe(0);
  });
});
