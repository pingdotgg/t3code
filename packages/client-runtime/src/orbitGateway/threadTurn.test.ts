import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  orbitFirstTurnInput,
  sendOrbitFirstMessage,
  type OrbitFirstMessagePorts,
} from "./threadTurn.ts";
import { newOrbitThreadStart } from "./threadStart.ts";

const start = {
  ...newOrbitThreadStart({
    id: "s1",
    project: { id: 3, slug: "mealou", nodeName: "beast" },
    message: "Fix the login bug",
    suffix: "k3j9",
    threadId: "thread-1",
    messageId: "message-1",
    commandId: "command-1",
    now: 0,
  }),
  environmentId: "env-41",
};
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const projectId = ProjectId.make("project-1");

function ports(results: Array<{ ok: true } | { ok: false; error: unknown }>) {
  const launches: Array<ReturnType<typeof orbitFirstTurnInput>> = [];
  const value: OrbitFirstMessagePorts = {
    waitForClone: async () => ({ projectId, modelSelection }),
    waitForConnection: async () => true,
    startTurn: async (_environmentId, input) => {
      launches.push(input);
      return results.shift() ?? { ok: true };
    },
    now: () => "2026-11-10T08:00:00.000Z",
    stopped: () => false,
  };
  return { launches, ports: value };
}

describe("orbitFirstTurnInput", () => {
  it("launches a new thread with the first message in the clone's workspace project", () => {
    expect(
      orbitFirstTurnInput({ start, projectId, modelSelection, createdAt: "2026-11-10T08:00:00Z" }),
    ).toMatchObject({
      commandId: "command-1",
      threadId: "thread-1",
      message: { messageId: "message-1", role: "user", text: "Fix the login bug", attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "Fix the login bug",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      },
    });
  });

  it("uses the model and modes the start carries over the clone's defaults", async () => {
    const carried = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };
    const v2 = {
      ...start,
      modelSelection: carried,
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
    };
    const { launches, ports: run } = ports([]);
    // The carried model is enough even when the clone's server names none yet.
    const noDefault = { ...run, waitForClone: async () => ({ projectId, modelSelection: null }) };

    await expect(sendOrbitFirstMessage(v2, noDefault)).resolves.toBe(projectId);
    expect(launches[0]).toMatchObject({
      modelSelection: carried,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      bootstrap: {
        createThread: {
          modelSelection: carried,
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      },
    });
  });
});

describe("sendOrbitFirstMessage", () => {
  it("repeats the same launch command after a dispatch that failed, so the server finishes it", async () => {
    // The thread is created, then the message dispatch fails: the launch is not sent yet.
    const { launches, ports: run } = ports([
      { ok: false, error: new Error("socket closed") },
      { ok: true },
    ]);

    await expect(sendOrbitFirstMessage(start, run)).rejects.toThrow("socket closed");
    // Retry, or a resume after a reload.
    await expect(sendOrbitFirstMessage(start, run)).resolves.toBe(projectId);

    expect(launches.map((launch) => launch.commandId)).toEqual(["command-1", "command-1"]);
  });

  it("never counts a refused launch as sent", async () => {
    const { ports: run } = ports([
      { ok: false, error: new Error("Thread thread-1 already exists") },
    ]);

    await expect(sendOrbitFirstMessage(start, run)).rejects.toThrow("did not take");
  });

  it("sends nothing once the start was dismissed", async () => {
    const { launches, ports: run } = ports([]);

    await expect(sendOrbitFirstMessage(start, { ...run, stopped: () => true })).rejects.toThrow(
      "stopped",
    );
    expect(launches).toEqual([]);
  });

  it("sends only once the clone's connection is connected", async () => {
    // The clone shows as ready from cache while its session still reconnects.
    const { launches, ports: run } = ports([]);
    const connection = Promise.withResolvers<boolean>();
    const waiting = Promise.withResolvers<void>();
    const reconnecting = {
      ...run,
      waitForConnection: () => {
        waiting.resolve();
        return connection.promise;
      },
    };

    const sent = sendOrbitFirstMessage(start, reconnecting);
    await waiting.promise;
    expect(launches).toEqual([]);
    connection.resolve(true);
    await expect(sent).resolves.toBe(projectId);
    expect(launches).toHaveLength(1);
  });

  it("sends nothing when the clone's connection does not come up in time", async () => {
    const { launches, ports: run } = ports([]);
    const offline = { ...run, waitForConnection: async () => false };

    await expect(sendOrbitFirstMessage(start, offline)).rejects.toThrow("did not connect");
    expect(launches).toEqual([]);
  });

  it("stops when the clone's workspace project does not appear", async () => {
    const { launches, ports: run } = ports([]);
    const missing = { ...run, waitForClone: async () => null };

    await expect(sendOrbitFirstMessage(start, missing)).rejects.toThrow("/srv/workspace");
    expect(launches).toEqual([]);
  });

  it("falls back to the clone's default when the clone lacks the start's provider", async () => {
    const carried = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };
    const { launches, ports: run } = ports([]);
    const fallbacks: unknown[] = [];
    const lacking = {
      ...run,
      waitForClone: async () => ({
        projectId,
        modelSelection,
        offers: (selection: { instanceId: string }) => selection.instanceId === "codex",
      }),
      onModelFallback: (fallback: unknown) => fallbacks.push(fallback),
    };

    await expect(
      sendOrbitFirstMessage({ ...start, modelSelection: carried }, lacking),
    ).resolves.toBe(projectId);
    expect(launches[0]).toMatchObject({
      modelSelection,
      bootstrap: { createThread: { modelSelection } },
    });
    expect(fallbacks).toEqual([{ requestedModel: "opus", usedModel: "gpt-5" }]);
  });

  it("keeps the start's model when the clone offers it", async () => {
    const carried = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" };
    const { launches, ports: run } = ports([]);
    const fallbacks: unknown[] = [];
    const offering = {
      ...run,
      waitForClone: async () => ({ projectId, modelSelection, offers: () => true }),
      onModelFallback: (fallback: unknown) => fallbacks.push(fallback),
    };
    await sendOrbitFirstMessage({ ...start, modelSelection: carried }, offering);
    expect(launches[0]).toMatchObject({ modelSelection: carried });
    expect(fallbacks).toEqual([]);
  });
});
