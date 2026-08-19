import { managedRelaySessionAtom, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  activateManagedRelayAuthentication,
  deactivateManagedRelayAuthentication,
} from "./managedAuth";

vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
  runPrimaryHttp: vi.fn(),
}));

vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

afterEach(() => {
  deactivateManagedRelayAuthentication();
});

describe("managed relay authentication", () => {
  it("clears the session synchronously before account cleanup can fail", async () => {
    activateManagedRelayAuthentication("account-1", () => Promise.resolve("account-1-token"));
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");

    deactivateManagedRelayAuthentication();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    await cleanup;
  });

  it("replaces an existing account session atomically", () => {
    setManagedRelaySession(appAtomRegistry, {
      accountId: "account-1",
      readClerkToken: () => Promise.resolve("account-1-token"),
    });

    activateManagedRelayAuthentication("account-2", () => Promise.resolve("account-2-token"));

    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-2");
  });
});
