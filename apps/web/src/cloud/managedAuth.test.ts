import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  activateManagedRelayAuthentication,
  cleanUpManagedRelayAccount,
  deactivateManagedRelayAuthentication,
} from "./managedAuth";

vi.mock("@clerk/react", () => ({
  useClerk: vi.fn(),
}));

const resetTokenCache = vi.hoisted(() => vi.fn());

vi.mock("../lib/runtime", async () => {
  const Exit = await import("effect/Exit");
  return {
    runtime: {
      runPromiseExit: () => {
        resetTokenCache();
        return Promise.resolve(Exit.void);
      },
    },
  };
});

vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {
      label: "remove relay environments",
      run: () => Promise.reject(new Error("Persistence removal failed.")),
    },
  },
}));

afterEach(() => {
  deactivateManagedRelayAuthentication();
});

describe("managed relay authentication", () => {
  it("clears all token access synchronously before account cleanup can fail", async () => {
    activateManagedRelayAuthentication("account-1", async () => "account-1-token");
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
    const token = await Effect.fromNullishOr(appAtomRegistry.get(managedRelaySessionAtom)).pipe(
      Effect.flatMap((session) => session.readClerkToken()),
      Effect.runPromise,
    );
    expect(token).toBe("account-1-token");

    deactivateManagedRelayAuthentication();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    await cleanup;
  });

  it("fails the account switch when the previous account's routes cannot be removed", async () => {
    resetTokenCache.mockClear();
    await expect(cleanUpManagedRelayAccount()).rejects.toThrow("Persistence removal failed.");
    expect(resetTokenCache).toHaveBeenCalledTimes(1);
  });
});
