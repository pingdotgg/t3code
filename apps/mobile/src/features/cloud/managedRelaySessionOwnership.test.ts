import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createManagedRelaySessionOwnership } from "./managedRelaySessionOwnership";

function createHarness() {
  const registry = AtomRegistry.make();
  const ownership = createManagedRelaySessionOwnership(registry);
  const provider = (token: string) => vi.fn(async () => token);
  return { ownership, provider, registry };
}

describe("managed relay session ownership", () => {
  it("keeps the UI owner effective while a background owner is present", () => {
    const { ownership, provider, registry } = createHarness();
    const backgroundProvider = provider("background");
    const uiProvider = provider("ui");

    ownership.setOwner("background", {
      accountId: "account-1",
      readClerkToken: backgroundProvider,
    });
    ownership.setOwner("ui", { accountId: "account-1", readClerkToken: uiProvider });

    const session = registry.get(managedRelaySessionAtom);
    expect(session?.accountId).toBe("account-1");
    ownership.releaseOwner("ui");
    expect(registry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
  });

  it("releasing one owner preserves the other owner", () => {
    const { ownership, provider, registry } = createHarness();
    const releaseBackground = ownership.setOwner("background", {
      accountId: "account-1",
      readClerkToken: provider("background"),
    });
    ownership.setOwner("ui", {
      accountId: "account-1",
      readClerkToken: provider("ui"),
    });

    expect(releaseBackground).not.toBeNull();
    releaseBackground?.();
    expect(registry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
    ownership.releaseOwner("ui");
    expect(registry.get(managedRelaySessionAtom)).toBeNull();
  });

  it("does not let an obsolete release remove a newer lease", () => {
    const { ownership, provider, registry } = createHarness();
    const releaseFirst = ownership.setOwner("background", {
      accountId: "account-1",
      readClerkToken: provider("first"),
    });
    ownership.setOwner("background", {
      accountId: "account-1",
      readClerkToken: provider("second"),
    });

    expect(releaseFirst).not.toBeNull();
    releaseFirst?.();
    expect(registry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
  });

  it("invalidates a stale background owner on a UI account switch", () => {
    const { ownership, provider, registry } = createHarness();
    ownership.setOwner("background", {
      accountId: "account-1",
      readClerkToken: provider("background"),
    });
    ownership.setOwner("ui", {
      accountId: "account-2",
      readClerkToken: provider("ui"),
    });

    ownership.releaseOwner("ui");
    expect(registry.get(managedRelaySessionAtom)).toBeNull();
  });

  it("rejects a stale background bootstrap that completes after a UI switch", () => {
    const { ownership, provider, registry } = createHarness();
    ownership.setOwner("ui", {
      accountId: "account-2",
      readClerkToken: provider("ui"),
    });
    const rejected = ownership.setOwner("background", {
      accountId: "account-1",
      readClerkToken: provider("background"),
    });

    expect(rejected).toBeNull();
    ownership.releaseOwner("ui");
    expect(registry.get(managedRelaySessionAtom)).toBeNull();
  });

  it("clears both owners for sign-out", () => {
    const { ownership, provider, registry } = createHarness();
    ownership.setOwner("background", {
      accountId: "account-1",
      readClerkToken: provider("background"),
    });
    ownership.setOwner("ui", {
      accountId: "account-1",
      readClerkToken: provider("ui"),
    });

    ownership.clear();
    expect(registry.get(managedRelaySessionAtom)).toBeNull();
  });
});
