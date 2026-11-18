import {
  OrbitGatewayError,
  type OrbitGatewayClient,
  type OrbitGatewayWorkspace,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it } from "vite-plus/test";

import {
  parseWorkspaceProfileSyncState,
  syncWorkspaceProfile,
  type WorkspaceProfileSyncPorts,
  type WorkspaceProfileSyncState,
} from "./workspaceProfileSync";

const ws = (id: string, name = id): OrbitGatewayWorkspace => ({
  id,
  name,
  color: "sky",
  icon: null,
  image: null,
  projectRefs: [],
  projectKeys: [],
});
const names = (list: readonly OrbitGatewayWorkspace[]) => list.map((entry) => entry.name);

/** An in-memory Gateway with one profile, checking versions the way the real one does. */
function gateway(initial: {
  bound?: boolean;
  version?: number;
  workspaces?: OrbitGatewayWorkspace[];
}) {
  const profile = {
    bound: initial.bound ?? true,
    version: initial.version ?? 1,
    workspaces: initial.workspaces ?? [],
  };
  const writes: number[] = [];
  const settings = () => ({
    profileId: 1,
    version: profile.version,
    workspaces: profile.workspaces,
    updatedAt: "",
  });
  const client = {
    me: async () => ({
      id: 8,
      name: "nick",
      wireguardIp: "10.44.0.6",
      profile: profile.bound
        ? { id: 1, name: "Nick", settingsVersion: profile.version, updatedAt: "" }
        : null,
    }),
    settings: async () => settings(),
    replaceWorkspaces: async (
      _id: number,
      version: number,
      workspaces: readonly OrbitGatewayWorkspace[],
    ) => {
      if (version !== profile.version) {
        throw new OrbitGatewayError({
          code: "conn.settings_version_conflict",
          message: "stale",
          status: 409,
          details: { current_version: profile.version },
        });
      }
      profile.version += 1;
      profile.workspaces = [...workspaces];
      writes.push(profile.version);
      return settings();
    },
  } as unknown as OrbitGatewayClient;
  return { client, profile, writes };
}

function device(
  client: OrbitGatewayClient,
  local: OrbitGatewayWorkspace[],
  state: WorkspaceProfileSyncState | null = null,
) {
  const memory = { local, state };
  const ports: WorkspaceProfileSyncPorts = {
    client,
    readLocal: () => memory.local,
    writeLocal: (workspaces) => {
      memory.local = [...workspaces];
    },
    loadState: () => memory.state,
    saveState: (next) => {
      memory.state = next;
    },
  };
  return { ports, memory };
}

describe("syncWorkspaceProfile", () => {
  it("does nothing while the device has no profile", async () => {
    const { client } = gateway({ bound: false });
    const { ports, memory } = device(client, [ws("a")]);
    await expect(syncWorkspaceProfile(ports)).resolves.toEqual({ kind: "unbound" });
    expect(names(memory.local)).toEqual(["a"]);
  });

  it("replaces local workspaces with the profile's on the first sync", async () => {
    const { client } = gateway({ version: 2, workspaces: [ws("p", "Orbit")] });
    const { ports, memory } = device(client, [ws("a", "old local")]);
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({
      kind: "pulled",
      profileName: "Nick",
    });
    expect(names(memory.local)).toEqual(["Orbit"]);
    expect(memory.state).toMatchObject({ profileId: 1, version: 2 });
  });

  it("seeds an empty profile from this device", async () => {
    const remote = gateway({ version: 1 });
    const { ports } = device(remote.client, [ws("a", "Apps")]);
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({ kind: "pushed" });
    expect(names(remote.profile.workspaces)).toEqual(["Apps"]);
  });

  it("sends a local edit and reads nothing when nobody else wrote", async () => {
    const remote = gateway({ version: 2, workspaces: [ws("a")] });
    const { ports, memory } = device(remote.client, [ws("a")], {
      profileId: 1,
      version: 2,
      base: [ws("a")],
    });
    memory.local = [ws("a", "renamed")];
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({ kind: "pushed" });
    expect(names(remote.profile.workspaces)).toEqual(["renamed"]);
    expect(memory.state?.version).toBe(3);
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({ kind: "unchanged" });
    expect(remote.writes).toEqual([3]);
  });

  it("pulls another device's edit", async () => {
    const remote = gateway({ version: 2, workspaces: [ws("a")] });
    const { ports, memory } = device(remote.client, [ws("a")], {
      profileId: 1,
      version: 2,
      base: [ws("a")],
    });
    remote.profile.workspaces = [ws("a"), ws("b", "from phone")];
    remote.profile.version = 3;
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({ kind: "pulled" });
    expect(names(memory.local)).toEqual(["a", "from phone"]);
  });

  it("merges when both devices edited since the last sync", async () => {
    const remote = gateway({ version: 2, workspaces: [ws("a"), ws("b")] });
    const { ports, memory } = device(remote.client, [ws("a"), ws("b")], {
      profileId: 1,
      version: 2,
      base: [ws("a"), ws("b")],
    });
    remote.profile.workspaces = [ws("a"), ws("b", "B on phone")];
    remote.profile.version = 3;
    memory.local = [ws("a", "A on desktop"), ws("b")];
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({ kind: "merged" });
    expect(names(remote.profile.workspaces)).toEqual(["A on desktop", "B on phone"]);
    expect(names(memory.local)).toEqual(["A on desktop", "B on phone"]);
    expect(memory.state?.version).toBe(4);
  });

  it("keeps a desktop edit made while another device's change is being read", async () => {
    const remote = gateway({ version: 2, workspaces: [ws("a"), ws("b")] });
    let editDuringRead = (): void => {};
    const client = {
      ...remote.client,
      settings: async (profileId: number) => {
        const answer = await remote.client.settings(profileId);
        editDuringRead();
        return answer;
      },
    } as OrbitGatewayClient;
    const { ports, memory } = device(client, [ws("a"), ws("b")], {
      profileId: 1,
      version: 2,
      base: [ws("a"), ws("b")],
    });
    remote.profile.workspaces = [ws("a"), ws("b"), ws("c", "from phone")];
    remote.profile.version = 3;
    editDuringRead = () => {
      memory.local = [ws("a", "renamed on desktop"), ws("b")];
    };
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({ kind: "merged" });
    expect(names(remote.profile.workspaces)).toEqual(["renamed on desktop", "b", "from phone"]);
    expect(names(memory.local)).toEqual(["renamed on desktop", "b", "from phone"]);
  });
});

describe("syncWorkspaceProfile with edits during its requests", () => {
  function editingGateway() {
    const remote = gateway({ version: 2, workspaces: [ws("a"), ws("b")] });
    const hooks = { afterRead: (): void => {}, afterWrite: (): void => {} };
    const client = {
      ...remote.client,
      settings: async (profileId: number) => {
        const answer = await remote.client.settings(profileId);
        hooks.afterRead();
        return answer;
      },
      replaceWorkspaces: async (
        profileId: number,
        version: number,
        workspaces: readonly OrbitGatewayWorkspace[],
      ) => {
        const answer = await remote.client.replaceWorkspaces(profileId, version, workspaces);
        hooks.afterWrite();
        return answer;
      },
    } as OrbitGatewayClient;
    const { ports, memory } = device(client, [ws("a"), ws("b")], {
      profileId: 1,
      version: 2,
      base: [ws("a"), ws("b")],
    });
    return { remote, hooks, ports, memory };
  }

  it("keeps a second edit made during the conflict read", async () => {
    const { remote, hooks, ports, memory } = editingGateway();
    remote.profile.workspaces = [ws("a"), ws("b"), ws("c", "from phone")];
    remote.profile.version = 3;
    memory.local = [ws("a", "first rename"), ws("b")];
    hooks.afterRead = () => {
      hooks.afterRead = () => {};
      memory.local = [ws("a", "second rename"), ws("b")];
    };
    await syncWorkspaceProfile(ports);
    await syncWorkspaceProfile(ports);
    expect(names(remote.profile.workspaces)).toEqual(["second rename", "b", "from phone"]);
    expect(names(memory.local)).toEqual(["second rename", "b", "from phone"]);
  });

  it("sends an edit made while the write was in flight in the same run", async () => {
    const { remote, hooks, ports, memory } = editingGateway();
    memory.local = [ws("a", "first rename"), ws("b")];
    hooks.afterWrite = () => {
      hooks.afterWrite = () => {};
      memory.local = [ws("a", "first rename"), ws("b", "edited meanwhile")];
    };
    // A profile switch waits on this run, so the edit must reach this profile now.
    await syncWorkspaceProfile(ports);
    expect(names(remote.profile.workspaces)).toEqual(["first rename", "edited meanwhile"]);
    expect(names(memory.local)).toEqual(["first rename", "edited meanwhile"]);
    expect(memory.state?.version).toBe(remote.profile.version);
  });

  it("sends an edit made during the last allowed write after two conflicts", async () => {
    const { remote, hooks, ports, memory } = editingGateway();
    memory.local = [ws("a", "first rename"), ws("b")];
    // Another device writes before the first PUT and again during the first conflict read.
    let conflictsLeft = 1;
    const realRead = hooks.afterRead;
    hooks.afterRead = () => {
      realRead();
      if (conflictsLeft > 0) {
        conflictsLeft -= 1;
        remote.profile.version += 1;
      }
    };
    remote.profile.version += 1;
    hooks.afterWrite = () => {
      hooks.afterWrite = () => {};
      memory.local = [ws("a", "second rename"), ws("b")];
    };
    await syncWorkspaceProfile(ports);
    expect(names(remote.profile.workspaces)).toEqual(["second rename", "b"]);
    expect(names(memory.local)).toEqual(["second rename", "b"]);
  });

  it("writes nothing more when the edit equals the profile after a conflict", async () => {
    const { remote, hooks, ports, memory } = editingGateway();
    remote.profile.workspaces = [ws("a", "same"), ws("b")];
    remote.profile.version = 3;
    memory.local = [ws("a", "draft"), ws("b")];
    hooks.afterRead = () => {
      memory.local = [ws("a", "same"), ws("b")];
    };
    await syncWorkspaceProfile(ports);
    expect(remote.writes).toEqual([]);
    expect(memory.state?.version).toBe(3);
    expect(names(memory.local)).toEqual(["same", "b"]);
  });

  it("adopts an edit that already equals the newer profile without writing", async () => {
    const { remote, hooks, ports, memory } = editingGateway();
    remote.profile.workspaces = [ws("a", "same"), ws("b")];
    remote.profile.version = 3;
    hooks.afterRead = () => {
      memory.local = [ws("a", "same"), ws("b")];
    };
    await expect(syncWorkspaceProfile(ports)).resolves.toMatchObject({ kind: "pulled" });
    expect(remote.writes).toEqual([]);
    expect(memory.state?.version).toBe(3);
  });
});

describe("parseWorkspaceProfileSyncState", () => {
  it("accepts a stored snapshot", () => {
    const stored = JSON.parse(JSON.stringify({ profileId: 1, version: 2, base: [ws("a")] }));
    expect(parseWorkspaceProfileSyncState(stored)).toEqual({
      profileId: 1,
      version: 2,
      base: [ws("a")],
    });
    expect(parseWorkspaceProfileSyncState({ profileId: 1, version: 0, base: [] })).not.toBeNull();
  });

  it.each([
    ["null", null],
    ["a string", "state"],
    ["a list", []],
    ["a missing profile id", { version: 1, base: [] }],
    ["a string version", { profileId: 1, version: "1", base: [] }],
    ["a missing base", { profileId: 1, version: 1 }],
    ["a base that is not a list", { profileId: 1, version: 1, base: {} }],
    ["a base entry without an id", { profileId: 1, version: 1, base: [{ name: "a" }] }],
    ["a base entry that is not an object", { profileId: 1, version: 1, base: ["a"] }],
    [
      "a base entry with bad project keys",
      { profileId: 1, version: 1, base: [{ ...ws("a"), projectKeys: [1] }] },
    ],
  ])("treats %s as no snapshot", (_name, value) => {
    expect(parseWorkspaceProfileSyncState(value)).toBeNull();
  });
});
