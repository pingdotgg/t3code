import { describe, expect, it, vi } from "vite-plus/test";

import type {
  OrbitGatewayNode,
  OrbitGatewaySettings,
  OrbitGatewayWorkspace,
} from "@t3tools/client-runtime/orbit-gateway";

/** The Gateway and the phone's other parts, which each test sets up through `setup()`. */
const fake = vi.hoisted(() => ({
  boundProfile: 1 as number | null,
  profilesFailures: 0,
  versions: new Map<number, number>(),
  meFailures: 0,
  holdProfiles: null as Promise<void> | null,
  holdWrite: null as Promise<void> | null,
  holdSettings: null as Promise<void> | null,
  bindFailure: null as string | null,
  holdBind: null as Promise<void> | null,
}));

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => JSON.stringify({ provider: "orbit" }),
  setItemAsync: async () => {},
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: async () => ({}) }));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("../../connection/onboarding", () => ({ connectPairingUrl: {} }));
vi.mock("../../state/atom-registry", () => ({
  // The catalog is not ready, so a refresh changes no saved environment.
  appAtomRegistry: { get: () => ({ isReady: false }), subscribe: () => () => {} },
}));
vi.mock("../../state/session", () => ({
  environmentSession: {},
  readEnvironmentLacksScope: () => false,
}));
vi.mock("./orbitProfileSync", () => ({ runOrbitAppearance: async () => true }));
vi.mock("./orbitThreadStartStore", () => ({
  heldOrbitInstanceIds: () => [],
  orbitThreadStartStore: { loaded: () => false },
}));
vi.mock("./orbitWorkspaceRef", () => ({
  addProjectRefToProfileWorkspace: async (
    _client: unknown,
    profileId: number,
  ): Promise<OrbitGatewaySettings> => {
    const version = (fake.versions.get(profileId) ?? 1) + 1;
    fake.versions.set(profileId, version);
    const answer = settingsOf(profileId, version);
    if (fake.holdWrite) await fake.holdWrite;
    return answer;
  },
}));
vi.mock("./orbitGatewayClient", () => ({
  // No Reverb: the store's reads are what the tests observe.
  orbitGatewayTransport: async () => ({
    status: 200,
    body: JSON.stringify({ data: { url: null, key: null } }),
  }),
  orbitGatewayClient: {
    me: async (): Promise<OrbitGatewayNode> => {
      if (fake.meFailures > 0) {
        fake.meFailures -= 1;
        throw new Error("Gateway unreachable");
      }
      const id = fake.boundProfile;
      return {
        id: 7,
        name: "phone",
        wireguardIp: "10.44.0.30",
        profile:
          id === null
            ? null
            : { id, name: `P${id}`, settingsVersion: fake.versions.get(id) ?? 1, updatedAt: "" },
        profileChannel: null,
      };
    },
    profiles: async () => {
      if (fake.holdProfiles) await fake.holdProfiles;
      if (fake.profilesFailures > 0) {
        fake.profilesFailures -= 1;
        throw new Error("Gateway unreachable");
      }
      return [];
    },
    environments: async () => [],
    settings: async (profileId: number) => {
      const answer = settingsOf(profileId, fake.versions.get(profileId) ?? 1);
      if (fake.holdSettings) await fake.holdSettings;
      return answer;
    },
    bindProfile: async (profileId: number) => {
      if (fake.holdBind) await fake.holdBind;
      if (fake.bindFailure) throw new Error(fake.bindFailure);
      fake.boundProfile = profileId;
    },
  },
}));

function workspace(id: string): OrbitGatewayWorkspace {
  return { id, name: id, color: "slate", icon: null };
}

function settingsOf(profileId: number, version: number): OrbitGatewaySettings {
  return {
    profileId,
    version,
    workspaces: [workspace(`ws-${profileId}-v${version}`)],
    updatedAt: "",
    document: {},
    sections: {},
  };
}

async function setup() {
  vi.useFakeTimers();
  vi.resetModules();
  Object.assign(fake, {
    boundProfile: 1,
    versions: new Map([
      [1, 1],
      [2, 1],
    ]),
    meFailures: 0,
    profilesFailures: 0,
    holdProfiles: null,
    holdWrite: null,
    holdSettings: null,
    bindFailure: null,
    holdBind: null,
  });
  const store = await import("./orbitGatewayStore");
  const settle = () => vi.advanceTimersByTimeAsync(0);
  return {
    store,
    settle,
    shown: () => ({
      profile: store.orbitGatewayState().node?.profile?.id ?? null,
      workspaces: store.orbitGatewayState().workspaces.map((entry) => entry.id),
    }),
    [Symbol.dispose]() {
      vi.useRealTimers();
    },
  };
}

describe("Orbit Gateway store", () => {
  it("reads the new profile after a bind, also while a refresh still runs", async () => {
    using t = await setup();
    t.store.startOrbitGateway();
    await t.settle();
    expect(t.shown()).toEqual({ profile: 1, workspaces: ["ws-1-v1"] });

    const lists = Promise.withResolvers<void>();
    fake.holdProfiles = lists.promise;
    void t.store.refreshOrbitGateway();
    await t.settle();
    const chosen = t.store.chooseOrbitProfile({ id: 2 });
    fake.holdProfiles = null;
    lists.resolve();
    await chosen;
    await t.settle();
    expect(t.shown()).toEqual({ profile: 2, workspaces: ["ws-2-v1"] });
  });

  it("never shows the old profile from a read that ran while the bind was pending", async () => {
    using t = await setup();
    t.store.startOrbitGateway();
    await t.settle();
    const seen: string[][] = [];
    t.store.subscribeOrbitGateway(() => seen.push(t.shown().workspaces));
    const bind = Promise.withResolvers<void>();
    fake.holdBind = bind.promise;
    const chosen = t.store.chooseOrbitProfile({ id: 2 });
    await t.settle();
    // Another device moves A to v2; the periodic check reads it while the bind is pending.
    fake.versions.set(1, 2);
    const answer = Promise.withResolvers<void>();
    fake.holdSettings = answer.promise;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    fake.holdSettings = null;
    fake.holdBind = null;
    bind.resolve();
    await t.settle();
    answer.resolve();
    await chosen;
    await t.settle();
    expect(t.shown()).toEqual({ profile: 2, workspaces: ["ws-2-v1"] });
    expect(seen.flat()).not.toContain("ws-1-v2");
  });

  it("does not let a late workspace write of the old profile replace the new one", async () => {
    using t = await setup();
    t.store.startOrbitGateway();
    await t.settle();
    const write = Promise.withResolvers<void>();
    fake.holdWrite = write.promise;
    const kept = t.store.keepProjectInOrbitWorkspace("ws-1-v1", "env:project");
    await t.settle();
    fake.holdWrite = null;
    await t.store.chooseOrbitProfile({ id: 2 });
    await t.settle();
    expect(t.shown()).toEqual({ profile: 2, workspaces: ["ws-2-v1"] });
    write.resolve();
    await kept;
    expect(t.shown()).toEqual({ profile: 2, workspaces: ["ws-2-v1"] });
  });

  it("keeps a workspace write that lands before the first read's older answer", async () => {
    using t = await setup();
    const firstRead = Promise.withResolvers<void>();
    fake.holdSettings = firstRead.promise;
    t.store.startOrbitGateway();
    await t.settle();
    fake.holdSettings = null;
    // A resumed thread start writes v2 while the first read still holds v1.
    await t.store.keepProjectInOrbitWorkspace("ws-1-v1", "env:project");
    firstRead.resolve();
    await t.settle();
    expect(t.shown()).toEqual({ profile: 1, workspaces: ["ws-1-v2"] });
  });

  it("never shows a startup write for a profile the phone turns out not to be bound to", async () => {
    using t = await setup();
    fake.boundProfile = 2;
    const firstRead = Promise.withResolvers<void>();
    fake.holdSettings = firstRead.promise;
    t.store.startOrbitGateway();
    await t.settle();
    fake.holdSettings = null;
    // A resumed thread start for profile A, which this phone has left.
    fake.boundProfile = 1;
    await t.store.keepProjectInOrbitWorkspace("ws-1-v1", "env:project");
    fake.boundProfile = 2;
    expect(t.shown().workspaces).toEqual([]);
    firstRead.resolve();
    await t.settle();
    expect(t.shown()).toEqual({ profile: 2, workspaces: ["ws-2-v1"] });
  });

  it("does not bring a failed bind's error back after a later profile read fails", async () => {
    using t = await setup();
    t.store.startOrbitGateway();
    await t.settle();
    const lists = Promise.withResolvers<void>();
    fake.holdProfiles = lists.promise;
    void t.store.refreshOrbitGateway();
    await t.settle();
    fake.bindFailure = "bind denied";
    await expect(t.store.chooseOrbitProfile({ id: 2 })).rejects.toThrow("bind denied");
    fake.holdProfiles = null;
    lists.resolve();
    await t.settle();
    expect(t.store.orbitGatewayState().error).toBeNull();
    // The next profile check fails on its own, without a list refresh.
    fake.meFailures = 1;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(t.store.orbitGatewayState().error).toBe("Gateway unreachable");
  });

  it("does not let a late workspace write show workspaces in Default mode", async () => {
    using t = await setup();
    t.store.startOrbitGateway();
    await t.settle();
    const write = Promise.withResolvers<void>();
    fake.holdWrite = write.promise;
    const kept = t.store.keepProjectInOrbitWorkspace("ws-1-v1", "env:project");
    await t.settle();
    await t.store.setEnvironmentProvider("default");
    write.resolve();
    await kept;
    expect(t.shown()).toEqual({ profile: null, workspaces: [] });
  });

  it("shows the workspaces again after Default and back to Orbit", async () => {
    using t = await setup();
    t.store.startOrbitGateway();
    await t.settle();
    await t.store.setEnvironmentProvider("default");
    expect(t.shown()).toEqual({ profile: null, workspaces: [] });
    await t.store.setEnvironmentProvider("orbit");
    await t.settle();
    expect(t.shown()).toEqual({ profile: 1, workspaces: ["ws-1-v1"] });
  });

  it("clears a profile read error when the retry finds the phone unbound", async () => {
    using t = await setup();
    fake.meFailures = 1;
    t.store.startOrbitGateway();
    await t.settle();
    fake.boundProfile = null;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.store.orbitGatewayState()).toMatchObject({ error: null, phase: "ready" });
  });

  it("keeps a list failure shown when only the profile read recovers", async () => {
    using t = await setup();
    fake.meFailures = 1;
    fake.profilesFailures = 1;
    t.store.startOrbitGateway();
    await t.settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.shown()).toEqual({ profile: 1, workspaces: ["ws-1-v1"] });
    expect(t.store.orbitGatewayState()).toMatchObject({
      error: "Gateway unreachable",
      phase: "error",
    });
  });

  it("clears the error a failed profile read showed once a retry succeeds", async () => {
    using t = await setup();
    fake.meFailures = 1;
    t.store.startOrbitGateway();
    await t.settle();
    expect(t.store.orbitGatewayState().error).toBe("Gateway unreachable");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.store.orbitGatewayState()).toMatchObject({ error: null, phase: "ready" });
    expect(t.shown()).toEqual({ profile: 1, workspaces: ["ws-1-v1"] });
  });
});
