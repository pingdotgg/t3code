import { expect, it, vi } from "vite-plus/test";

import type { GatewayProfile, GatewayRuntimePort } from "./port.ts";
import { withinModes } from "./portModes.ts";

const EDITS = { runtimeMode: "auto-accept-edits", interactionMode: "default" } as const;
const FULL = { runtimeMode: "full-access", interactionMode: "default" } as const;

const narrow = {
  profileId: "narrow",
  name: "Narrow",
  runtimeMode: "approval-required",
  interactionMode: "default",
} as unknown as GatewayProfile;

/** Every shared library write, on a skill and agent no broader agent uses. */
const writes = {
  createSkill: ["remote", { name: "Notes", description: "", content: "Take notes" }],
  updateSkill: ["remote", "unused", { content: "Take more notes" }],
  deleteSkill: ["remote", "unused"],
  createProfile: ["remote", narrow],
  updateProfile: ["remote", "narrow", { name: "Narrower" }],
  deleteProfile: ["remote", "narrow"],
  replicateProfiles: ["remote", [narrow]],
} as const;

const library = () => {
  const calls = Object.fromEntries(
    [...Object.keys(writes), "listSkills", "syncAgentLibrary"].map((method) => [
      method,
      vi.fn(async () => undefined),
    ]),
  );
  return {
    calls,
    port: { ...calls, listProfiles: async () => [narrow] } as unknown as GatewayRuntimePort,
  };
};

it.each(Object.entries(writes))(
  "%s writes the library every machine syncs, so only a full-access chat may",
  async (method, args) => {
    const limited = library();
    const call = (port: GatewayRuntimePort) =>
      (port[method as keyof GatewayRuntimePort] as (...a: ReadonlyArray<unknown>) => unknown)(
        ...args,
      );
    await expect(call(withinModes(limited.port, EDITS))).rejects.toThrow("full-access");
    expect(limited.calls[method]).not.toHaveBeenCalled();

    const full = library();
    await call(withinModes(full.port, FULL));
    expect(full.calls[method]).toHaveBeenCalledOnce();
  },
);

it("lets a limited chat read and sync the library it cannot change", async () => {
  const limited = library();
  const guarded = withinModes(limited.port, EDITS);
  await guarded.listSkills!("remote");
  await guarded.syncAgentLibrary!("remote");
  expect(limited.calls.listSkills).toHaveBeenCalledOnce();
  expect(limited.calls.syncAgentLibrary).toHaveBeenCalledOnce();
});

it("lets a chat's task call from another server touch only threads within its modes", async () => {
  const threadTask = vi.fn(async () => ({}));
  const modes = {
    "worker-edits": EDITS,
    "worker-wide": { runtimeMode: "full-access", interactionMode: "default" },
  };
  const port = {
    threadTask,
    getThread: async (_environmentId: string, threadId: keyof typeof modes) => ({
      id: threadId,
      ...modes[threadId],
    }),
  } as unknown as GatewayRuntimePort;
  const guarded = withinModes(port, EDITS);
  const assign = (workerThreadId: string) => ({
    action: "remoteAssign",
    input: { workerThreadId },
  });
  const ownerAction = (threadId: string) => ({
    action: "remoteOwnerAction",
    input: { update: { threadId } },
  });
  await guarded.threadTask!("remote", assign("worker-edits") as never);
  await guarded.threadTask!("remote", ownerAction("worker-edits") as never);
  await expect(guarded.threadTask!("remote", assign("worker-wide") as never)).rejects.toThrow(
    "full-access",
  );
  await expect(guarded.threadTask!("remote", ownerAction("worker-wide") as never)).rejects.toThrow(
    "full-access",
  );
  expect(threadTask).toHaveBeenCalledTimes(2);
});
