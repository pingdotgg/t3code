import { expect, it, vi } from "vite-plus/test";

import type { GatewayProfile, GatewayRuntimePort } from "./port.ts";
import { withinModes } from "./portModes.ts";

const EDITS = { runtimeMode: "auto-accept-edits", interactionMode: "default" } as const;

const wide = {
  profileId: "wide",
  name: "Wide",
  runtimeMode: "full-access",
  interactionMode: "default",
  skillIds: ["skill-wide"],
} as unknown as GatewayProfile;

/** A target whose own full-access agent uses `skill-wide`, and a sync that would change `changed`. */
const target = (changed: ReadonlyArray<string>) => {
  const syncAgentLibrary = vi.fn(async () => undefined);
  const listSkills = vi.fn(async () => []);
  const replicateProfiles = vi.fn(async () => undefined);
  const port = {
    syncAgentLibrary,
    listSkills,
    replicateProfiles,
    listProfiles: async () => [wide],
    agentLibrarySync: async () => ({ skillIds: changed, profileIds: [], profiles: [] }),
  } as unknown as GatewayRuntimePort;
  return { port, syncAgentLibrary, listSkills, replicateProfiles };
};

it("refuses a library sync that would change an agent there broader than the calling chat", async () => {
  const touched = target(["skill-wide"]);
  const guarded = withinModes(touched.port, EDITS);
  await expect(guarded.syncAgentLibrary!("remote")).rejects.toThrow("full-access");
  // Listing skills synchronizes the library first.
  await expect(guarded.listSkills!("remote")).rejects.toThrow("full-access");
  expect(touched.syncAgentLibrary).not.toHaveBeenCalled();
  expect(touched.listSkills).not.toHaveBeenCalled();

  const untouched = target(["skill-narrow"]);
  await withinModes(untouched.port, EDITS).syncAgentLibrary!("remote");
  expect(untouched.syncAgentLibrary).toHaveBeenCalledOnce();

  const narrowed = { ...wide, runtimeMode: "auto-accept-edits" } as GatewayProfile;
  await expect(
    withinModes(untouched.port, EDITS).replicateProfiles!("remote", [narrowed]),
  ).rejects.toThrow("full-access");
  expect(untouched.replicateProfiles).not.toHaveBeenCalled();
});
