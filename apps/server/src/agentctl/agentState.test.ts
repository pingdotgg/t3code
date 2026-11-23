import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import readyAgents from "./fixtures/get-agents-ready.json" with { type: "json" };
import { agentctlErrorMessage } from "./AgentctlCli.ts";
import {
  AgentResourceList,
  deriveAgentState,
  isConnectable,
  manifestVariant,
  shouldCloseTunnel,
  type AgentResource,
} from "./agentState.ts";
import { IDLE_RUNTIME, buildSandbox } from "./sandboxModel.ts";

const decodeAgentList = Schema.decodeUnknownSync(AgentResourceList);

type Condition = { type: string; status: string; reason?: string; message?: string };

function agent(input: {
  readonly conditions?: ReadonlyArray<Condition>;
  readonly runState?: string;
  readonly failure?: string;
  readonly progress?: string;
  readonly deleting?: boolean;
  readonly ssh?: boolean;
  readonly observedGeneration?: number;
}): AgentResource {
  return {
    metadata: {
      name: "worker",
      generation: 2,
      ...(input.deleting ? { deletionTimestamp: "2026-10-10T00:00:00Z" } : {}),
    },
    spec: {
      ...(input.runState === undefined ? {} : { runState: input.runState }),
      access: input.ssh === false ? [] : [{ type: "ssh" }],
    },
    status: {
      observedGeneration: input.observedGeneration ?? 2,
      conditions: input.conditions ?? [],
      ...(input.failure === undefined ? {} : { failure: input.failure }),
      ...(input.progress === undefined
        ? {}
        : {
            progress: {
              progress: {
                current: {
                  phase: { label: input.progress },
                  steps: [{ name: "Build Docker image" }],
                },
                status: { state: "running" },
              },
            },
          }),
    },
  };
}

const ready = (status: string, reason: string, message?: string): Condition => ({
  type: "Ready",
  status,
  reason,
  ...(message === undefined ? {} : { message }),
});

describe("deriveAgentState", () => {
  it.each([
    ["ready", agent({ conditions: [ready("True", "SandboxReady")] }), null],
    [
      "provisioning",
      agent({
        conditions: [ready("False", "ProviderSelected")],
        progress: "Resolve Sandbox Image",
      }),
      "Resolve Sandbox Image · Build Docker image",
    ],
    ["stopped", agent({ runState: "Stopped", conditions: [ready("False", "Stopped")] }), null],
    ["stopping", agent({ runState: "Stopped", conditions: [ready("True", "SandboxReady")] }), null],
    ["starting", agent({ conditions: [ready("False", "Starting")] }), null],
    [
      "failed",
      agent({
        conditions: [ready("False", "SshAccessFailed", "/usr/sbin/sshd is missing")],
        failure: "invalid",
      }),
      "/usr/sbin/sshd is missing",
    ],
    [
      "retrying",
      agent({
        conditions: [ready("False", "SandboxReconcileFailed", "boom")],
        failure: "transient",
      }),
      "boom",
    ],
    [
      "unresponsive",
      agent({
        conditions: [
          ready("False", "SandboxUnresponsive", "no heartbeat"),
          { type: "SandboxResponsive", status: "False" },
        ],
      }),
      "no heartbeat",
    ],
    ["terminating", agent({ deleting: true, conditions: [ready("True", "SandboxReady")] }), null],
    ["pending", agent({}), null],
  ] as const)("reads %s", (phase, resource, detail) => {
    expect(deriveAgentState(resource)).toEqual({ phase, detail });
  });

  it("ignores a failure recorded for an older generation", () => {
    const resource = agent({
      conditions: [ready("True", "SandboxReady")],
      failure: "invalid",
      observedGeneration: 1,
    });
    expect(deriveAgentState(resource).phase).toBe("ready");
  });
});

describe("isConnectable", () => {
  const sshReady: Condition = { type: "SshReady", status: "True", reason: "ServerRunning" };

  it("needs a Ready Agent whose SSH server is running", () => {
    expect(isConnectable(agent({ conditions: [ready("True", "SandboxReady"), sshReady] }))).toBe(
      true,
    );
    expect(isConnectable(agent({ conditions: [ready("True", "SandboxReady")] }))).toBe(false);
  });

  it("never connects to a stopped Agent or one without SSH access", () => {
    expect(
      isConnectable(
        agent({ runState: "Stopped", conditions: [ready("False", "Stopped"), sshReady] }),
      ),
    ).toBe(false);
    expect(
      isConnectable(agent({ ssh: false, conditions: [ready("True", "SandboxReady"), sshReady] })),
    ).toBe(false);
  });
});

describe("shouldCloseTunnel", () => {
  it("keeps the tunnel while a Sandbox only re-provisions", () => {
    expect(
      shouldCloseTunnel(
        agent({ conditions: [ready("False", "ProviderSelected")], progress: "Set up Agent" }),
      ),
    ).toBe(false);
  });

  it("closes it once the Sandbox stops or goes away", () => {
    expect(shouldCloseTunnel(undefined)).toBe(true);
    expect(
      shouldCloseTunnel(agent({ runState: "Stopped", conditions: [ready("False", "Stopped")] })),
    ).toBe(true);
    expect(shouldCloseTunnel(agent({ deleting: true }))).toBe(true);
  });
});

describe("agentctl output", () => {
  it("decodes real `get agents -o json` output, ignoring fields T3 does not read", () => {
    const [resource] = decodeAgentList(readyAgents);
    expect(resource?.metadata.name).toBe("worker");
    expect(resource && isConnectable(resource)).toBe(true);
    expect(manifestVariant(resource?.status?.provenance?.manifestPath ?? "")).toBe("nested");
    const sandbox = resource && buildSandbox(resource, undefined, IDLE_RUNTIME);
    expect(sandbox).toMatchObject({
      phase: "ready",
      since: "2026-10-10T16:28:32.743422188Z",
      cpu: "4",
      memory: "6Gi",
      disk: "32Gi",
      network: "mediated",
      harnesses: ["claudeCode"],
    });
  });

  it("reports agentctl's own error line rather than provisioning output", () => {
    expect(
      agentctlErrorMessage({
        exitCode: 1,
        stdout: "",
        stderr:
          "✓ Validate Sandbox request (0ms)\nagentctl: Agent control API error: Agent not found\n",
      }),
    ).toBe("Agent control API error: Agent not found");
  });
});

describe("manifestVariant", () => {
  it.each([
    ["/agents/dev/agent.yaml", null],
    ["/agents/dev/agent.nested.yaml", "nested"],
    ["/agents/dev/agent.big-box.yaml", "big-box"],
    ["/agents/dev/agent.Bad.yaml", null],
  ])("%s → %s", (path, variant) => {
    expect(manifestVariant(path)).toBe(variant);
  });
});
