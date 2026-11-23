import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { AgentResource } from "./agentState.ts";
import { manifestFileNames } from "./manifests.ts";
import { reconcileRecords, type SandboxRecord } from "./sandboxModel.ts";

function agent(
  name: string,
  options: { deleting?: boolean; stopped?: boolean } = {},
): AgentResource {
  return {
    metadata: {
      name,
      ...(options.deleting ? { deletionTimestamp: "2026-10-10T00:00:00Z" } : {}),
    },
    spec: options.stopped ? { runState: "Stopped" } : {},
    status: {
      conditions: [
        options.stopped
          ? { type: "Ready", status: "False", reason: "Stopped" }
          : { type: "Ready", status: "True", reason: "SandboxReady" },
      ],
    },
  };
}

const record: SandboxRecord = {
  environmentId: EnvironmentId.make("env-1"),
  sshTarget: { alias: "agentctl-worker", hostname: "worker", username: "agent", port: 22 },
};

describe("reconcileRecords", () => {
  it("keeps the environment of a Sandbox that is stopped", () => {
    const records = { worker: record };
    expect(reconcileRecords(records, [agent("worker", { stopped: true })])).toEqual(records);
  });

  it("forgets a Sandbox that was deleted or is being deleted", () => {
    const records = { gone: record, deleting: record };
    expect(reconcileRecords(records, [agent("deleting", { deleting: true })])).toEqual({});
  });
});

describe("manifestFileNames", () => {
  it("lists the base manifest first, then its variants", () => {
    expect(
      manifestFileNames([
        "README.md",
        "agent.nested.yaml",
        "agent.yaml",
        "agent.big.yaml",
        "Dockerfile",
      ]),
    ).toEqual(["agent.yaml", "agent.big.yaml", "agent.nested.yaml"]);
  });
});
