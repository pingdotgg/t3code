import type { AgentctlSandboxManifest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterManifestRepositories, groupManifests, pickAgentManifest } from "./manifestAgents";

function manifest(
  repository: string,
  relativeDirectory: string,
  variant: string | null,
  agentName: string | null,
): AgentctlSandboxManifest {
  const directory = relativeDirectory === "" ? repository : `${repository}/${relativeDirectory}`;
  return {
    path: `${directory}/${variant === null ? "agent.yaml" : `agent.${variant}.yaml`}`,
    directory,
    repository,
    variant,
    agentName,
  };
}

const T3CODE = "/home/me/code/t3code";
const AGENTS = "/home/me/code/agents";
const ALTINN = "/home/me/code/altinn-studio";

const manifests = [
  manifest(T3CODE, "agents/dev", null, "t3code-dev"),
  manifest(T3CODE, "agents/dev", "mine", "t3code-dev"),
  manifest(T3CODE, "agents/dev", "nested", "t3code-dev-nested"),
  manifest(AGENTS, "agentctl/examples/minimal", null, "minimal"),
  manifest(AGENTS, "agents/self-dev/full", null, "agentctl-dev"),
  manifest(AGENTS, "agents/self-dev/minimal", null, "agentctl-dev"),
  manifest(ALTINN, "agents", null, "altinn"),
  manifest(ALTINN, "agents/desktop", null, "altinn-desktop"),
  manifest(ALTINN, "agents/desktop", "nested", "altinn-desktop-nested"),
];

describe("groupManifests", () => {
  it("lists each folder once under its repository, labelled by where it sits in it", () => {
    expect(
      groupManifests(manifests).map((repository) => ({
        name: repository.name,
        agents: repository.agents.map((agent) => [
          agent.label,
          agent.manifests.map((entry) => entry.variant),
        ]),
      })),
    ).toEqual([
      { name: "t3code", agents: [["dev", [null, "mine", "nested"]]] },
      {
        name: "agents",
        agents: [
          ["agentctl/examples/minimal", [null]],
          ["self-dev/full", [null]],
          ["self-dev/minimal", [null]],
        ],
      },
      {
        name: "altinn-studio",
        agents: [
          ["altinn", [null]],
          ["desktop", [null, "nested"]],
        ],
      },
    ]);
  });
});

describe("filterManifestRepositories", () => {
  const repositories = groupManifests(manifests);
  const labels = (query: string) =>
    filterManifestRepositories(repositories, query).flatMap((repository) =>
      repository.agents.map((agent) => `${repository.name}/${agent.label}`),
    );

  it("needs every word to match the repository, folder, name or a variant", () => {
    expect(labels("")).toHaveLength(6);
    expect(labels("altinn nested")).toEqual(["altinn-studio/desktop"]);
    expect(labels("NESTED")).toEqual(["t3code/dev", "altinn-studio/desktop"]);
    expect(labels("agentctl-dev")).toEqual(["agents/self-dev/full", "agents/self-dev/minimal"]);
    expect(labels("nothing")).toEqual([]);
  });
});

describe("pickAgentManifest", () => {
  const [t3code] = groupManifests(manifests);
  const dev = t3code!.agents[0]!;

  it("prefers a variant the search named, then the current variant, then the base", () => {
    expect(pickAgentManifest(dev, "t3 nested", "mine")?.variant).toBe("nested");
    expect(pickAgentManifest(dev, "t3", "mine")?.variant).toBe("mine");
    expect(pickAgentManifest(dev, "", "worktree")?.variant).toBe(null);
  });
});
