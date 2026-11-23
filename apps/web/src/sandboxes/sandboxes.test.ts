import { EnvironmentId, type AgentctlSandbox } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canDeleteSandbox,
  canStopSandbox,
  sandboxStatus,
  suggestSandboxName,
} from "./sandboxActions";

function sandbox(overrides: Partial<AgentctlSandbox> = {}): AgentctlSandbox {
  return {
    name: "worker",
    phase: "ready",
    detail: null,
    since: null,
    cpu: null,
    memory: null,
    disk: null,
    network: null,
    sshAccess: true,
    environmentId: EnvironmentId.make("env-worker"),
    settingsSeeded: false,
    harnesses: [],
    workingDirectory: "/home/agent/code",
    connectError: null,
    action: null,
    actionError: null,
    manifestPath: null,
    variant: null,
    ...overrides,
  };
}

describe("sandboxStatus", () => {
  it("does not call a Sandbox running before T3 can reach it", () => {
    expect(sandboxStatus(sandbox({ environmentId: null })).label).toBe("Connecting…");
    expect(sandboxStatus(sandbox({ connectError: "no route" })).label).toBe("Cannot connect");
    expect(sandboxStatus(sandbox()).label).toBe("Running");
  });

  it("shows T3's own pending request first", () => {
    expect(sandboxStatus(sandbox({ phase: "stopped", action: "starting" })).label).toBe(
      "Starting…",
    );
  });
});

describe("suggestSandboxName", () => {
  const named = (...names: string[]) => names.map((name) => sandbox({ name }));

  it("numbers a new Sandbox one past the highest in use", () => {
    expect(suggestSandboxName("worker", [])).toBe("worker-1");
    expect(suggestSandboxName("worker", named("worker-1", "worker-3", "other-9"))).toBe("worker-4");
    expect(suggestSandboxName("worker", named("worker"))).toBe("worker-1");
    expect(suggestSandboxName(null, [])).toBe("sandbox-1");
  });

  it("only increments a manifest name that already ends in a number", () => {
    expect(suggestSandboxName("worker-2", [])).toBe("worker-2");
    expect(suggestSandboxName("worker-2", named("worker-2"))).toBe("worker-3");
    expect(suggestSandboxName("worker-2", named("worker-5"))).toBe("worker-6");
  });

  it("treats the name literally", () => {
    expect(suggestSandboxName("a.b", named("axb-4"))).toBe("a.b-1");
  });
});

describe("Sandbox actions", () => {
  it("keeps Stop and Delete within reach while a create is pending", () => {
    const creating = sandbox({ phase: "retrying", action: "creating" });
    expect(canStopSandbox(creating)).toBe(true);
    expect(canDeleteSandbox(creating)).toBe(true);
    expect(canDeleteSandbox(sandbox({ action: "deleting" }))).toBe(false);
    expect(canStopSandbox(sandbox({ phase: "stopped" }))).toBe(false);
  });
});
