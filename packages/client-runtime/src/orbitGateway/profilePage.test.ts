import { describe, expect, it } from "vite-plus/test";

import type { OrbitGatewayNode, OrbitGatewayProfile } from "./client.ts";
import {
  newOrbitProfileName,
  orbitProfileSummary,
  switchOrbitProfile,
  type OrbitProfileSyncView,
} from "./profilePage.ts";

function fakeSwitch() {
  const log: string[] = [];
  const profile = (id: number, name: string): OrbitGatewayProfile => ({
    id,
    name,
    settingsVersion: 1,
    updatedAt: "",
  });
  const ports = {
    client: {
      createProfile: async (name: string) => {
        log.push(`create ${name}`);
        return profile(9, name);
      },
      bindProfile: async (id: number): Promise<OrbitGatewayNode> => {
        log.push(`bind ${id}`);
        return { id: 45, name: "nick", wireguardIp: "10.44.0.12", profile: profile(id, "p") };
      },
    },
    sync: async () => {
      log.push("sync");
    },
    rebinding: (phase: "before" | "after") => {
      log.push(phase);
    },
  };
  return { log, ports };
}

describe("switchOrbitProfile", () => {
  it("sends unsent edits to the old profile before binding, then syncs the new one", async () => {
    const { log, ports } = fakeSwitch();
    const node = await switchOrbitProfile(ports, { id: 2 });
    expect(log).toEqual(["sync", "before", "bind 2", "after", "sync"]);
    expect(node.profile?.id).toBe(2);
  });

  it("creates a new profile by name and binds this device to it", async () => {
    const { log, ports } = fakeSwitch();
    await switchOrbitProfile(ports, { name: "Work" });
    expect(log).toEqual(["sync", "create Work", "before", "bind 9", "after", "sync"]);
  });

  it("follows the old profile again when the bind fails", async () => {
    const { log, ports } = fakeSwitch();
    const failing = {
      ...ports,
      client: {
        ...ports.client,
        bindProfile: async (): Promise<OrbitGatewayNode> => {
          throw new Error("bind denied");
        },
      },
    };
    await expect(switchOrbitProfile(failing, { id: 2 })).rejects.toThrow("bind denied");
    expect(log).toEqual(["sync", "before", "after", "sync"]);
  });

  it("does not bind when the profile cannot be created", async () => {
    const { log, ports } = fakeSwitch();
    const failing = {
      ...ports,
      client: {
        ...ports.client,
        createProfile: async () => {
          throw new Error("name taken");
        },
      },
    };
    await expect(switchOrbitProfile(failing, { name: "Work" })).rejects.toThrow("name taken");
    expect(log).toEqual(["sync"]);
  });
});

describe("newOrbitProfileName", () => {
  it("trims the name and refuses a blank one", () => {
    expect(newOrbitProfileName("  Work ")).toBe("Work");
    expect(newOrbitProfileName("   ")).toBeNull();
  });
});

describe("orbitProfileSummary", () => {
  const synced: OrbitProfileSyncView = {
    phase: "synced",
    error: null,
    syncedAt: 0,
    sections: "supported",
    sectionsError: null,
  };
  const all = { workspaces: true, appearance: true, desktop: true };
  const none = { workspaces: false, appearance: false, desktop: false };

  it.each([
    ["synced", synced, "Nick", "Synced with Nick. Last synced 2 min ago.", null, all],
    [
      "unsupported Gateway",
      { ...synced, sections: "unsupported" as const },
      "Nick",
      "Gateway doesn't support profile sync yet. Workspaces still sync with Nick.",
      null,
      { ...none, workspaces: true },
    ],
    [
      "sections failed",
      { ...synced, sectionsError: "too large" },
      "Nick",
      "Synced with Nick. Last synced 2 min ago.",
      "Appearance and settings: too large",
      { ...none, workspaces: true },
    ],
    [
      "sync failed",
      { ...synced, phase: "error" as const, error: "gateway.orbit timed out" },
      "Nick",
      "gateway.orbit timed out",
      null,
      none,
    ],
    [
      "no profile",
      { ...synced, phase: "unbound" as const },
      null,
      "Choose a profile to sync workspaces, appearance and settings.",
      null,
      none,
    ],
    [
      "first sync pending",
      { ...synced, phase: "off" as const, sections: "unknown" as const },
      "Nick",
      "Waiting for the first sync.",
      null,
      none,
    ],
  ])("%s", (_name, view, profile, description, problem, parts) => {
    expect(orbitProfileSummary(view, profile, 120_000)).toEqual({
      description,
      problem,
      synced: parts,
    });
  });
});
