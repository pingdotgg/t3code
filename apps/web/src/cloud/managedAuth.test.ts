import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  activateManagedRelayAuthentication,
  deactivateManagedRelayAuthentication,
} from "./managedAuth";

vi.mock("@clerk/react", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
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
});
