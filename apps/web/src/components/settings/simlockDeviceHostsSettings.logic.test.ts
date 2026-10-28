import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId } from "@t3tools/contracts";

import {
  newSimlockDeviceHost,
  planSimlockDeviceHostSave,
  simlockDeviceHostProblem,
  updateSimlockDeviceHosts,
} from "./simlockDeviceHostsSettings.logic";

const host = {
  ...newSimlockDeviceHost("simlock"),
  gatewayUrl: "https://gateway.example.ts.net:4700",
  agentToken: "agent",
};

describe("Simlock device host settings", () => {
  it("names what keeps a draft from saving", () => {
    expect(simlockDeviceHostProblem(host)).toBeNull();
    expect(simlockDeviceHostProblem({ ...host, label: " " })).toBe("Give the host a label.");
    expect(simlockDeviceHostProblem({ ...host, gatewayUrl: "gateway:4700" })).toMatch(/origin/);
    expect(
      simlockDeviceHostProblem({ ...host, gatewayUrl: "https://gateway.example/api" }),
    ).toMatch(/origin/);
    expect(simlockDeviceHostProblem({ ...host, maxLeases: 21 })).toMatch(/ranges/);
    expect(simlockDeviceHostProblem({ ...host, maxLeaseMinutes: 4 })).toMatch(/ranges/);
  });

  it("adds, replaces, and removes one host", () => {
    const other = { ...host, id: "other", label: "Other" };
    const added = updateSimlockDeviceHosts([other], host, false);
    expect(added.map((candidate) => candidate.id)).toEqual(["other", "simlock"]);
    const renamed = updateSimlockDeviceHosts(added, { ...host, label: "Renamed" }, false);
    expect(renamed.map((candidate) => candidate.label)).toEqual(["Other", "Renamed"]);
    expect(updateSimlockDeviceHosts(renamed, host, true)).toEqual([other]);
  });

  it("saves the shared fields everywhere and each environment's own token", () => {
    const mbp = "mbp" as EnvironmentId;
    const cups = "cups" as EnvironmentId;
    const environments = [
      { environmentId: mbp, label: "mbp", hosts: [{ ...host, agentToken: "<redacted>" }] },
      { environmentId: cups, label: "cups", hosts: [] },
    ];
    const draft = { ...host, label: "Pool", agentToken: "" };

    expect(
      planSimlockDeviceHostSave(environments, draft, new Map([[mbp, { kind: "saved" }]])),
    ).toEqual({
      problem: "Add an agent token for cups.",
    });
    expect(
      planSimlockDeviceHostSave(
        environments,
        draft,
        new Map([
          [mbp, { kind: "saved" }],
          [cups, { kind: "new", value: " cups-token " }],
        ]),
      ),
    ).toEqual({
      patches: [
        { environmentId: mbp, hosts: [{ ...draft, agentToken: "<redacted>" }] },
        { environmentId: cups, hosts: [{ ...draft, agentToken: "cups-token" }] },
      ],
    });
  });
});
