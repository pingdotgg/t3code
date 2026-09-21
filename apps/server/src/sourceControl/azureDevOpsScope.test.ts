import { describe, expect, it } from "vite-plus/test";
import {
  azureDevOpsScopeFromConfig,
  parseAzureDevOpsRemote,
  scopeAzureDevOpsArgs,
} from "./azureDevOpsScope.ts";

describe("Azure DevOps checkout scope", () => {
  it.each([
    "https://dev.azure.com/acme/My%20Project/_git/Repo",
    "https://user@dev.azure.com/acme/My%20Project/_git/Repo",
    "https://acme.visualstudio.com/DefaultCollection/My%20Project/_git/Repo",
    "https://acme.visualstudio.com/My%20Project/_git/Repo",
    "git@ssh.dev.azure.com:v3/acme/My%20Project/Repo",
    "ssh://git@ssh.dev.azure.com:22/v3/acme/My%20Project/Repo",
    "git@vs-ssh.visualstudio.com:v3/acme/My%20Project/Repo",
  ])("reads %s", (remote) => {
    expect(parseAzureDevOpsRemote(remote)).toEqual({
      organization: "https://dev.azure.com/acme",
      project: "My Project",
      repository: "Repo",
    });
  });

  it.each([
    "",
    "https://github.com/acme/repo",
    "https://dev.azure.com/acme",
    "https://dev.azure.com/acme/%XX/_git/repo",
    "git@ssh.dev.azure.com:v4/acme/project/repo",
  ])("leaves unsupported remotes to az: %s", (remote) => {
    expect(parseAzureDevOpsRemote(remote)).toBeNull();
  });

  it("prefers upstream without combining coordinates from different organizations", () => {
    expect(
      azureDevOpsScopeFromConfig(
        [
          "remote.origin.url https://dev.azure.com/fork/Project/_git/Fork",
          "remote.upstream.url https://dev.azure.com/upstream/Other/_git/Repo",
        ].join("\n"),
      ),
    ).toEqual({
      organization: "https://dev.azure.com/upstream",
      project: "Other",
      repository: "Repo",
    });
  });

  const scope = {
    organization: "https://dev.azure.com/acme",
    project: "Project",
    repository: "Repo",
  };
  it("honors checkout's explicit remote selection", () => {
    const config =
      "remote.upstream.url https://dev.azure.com/acme/Project/_git/Repo\nremote.origin.url https://dev.azure.com/fork/Project/_git/Fork";
    expect(azureDevOpsScopeFromConfig(config, "origin")?.organization).toBe(
      "https://dev.azure.com/fork",
    );
    expect(azureDevOpsScopeFromConfig(config, "missing")).toBeNull();
  });
  it("scopes listing to the repository rather than Azure CLI defaults", () => {
    expect(scopeAzureDevOpsArgs(["repos", "pr", "list", "--detect", "true"], scope)).toEqual([
      "repos",
      "pr",
      "list",
      "--detect",
      "false",
      "--organization",
      scope.organization,
      "--project",
      "Project",
      "--repository",
      "Repo",
    ]);
  });
  it.each([
    ["repos", "pr", "show"],
    ["repos", "pr", "update"],
    ["repos", "pr", "set-vote"],
    ["repos", "pr", "reviewer", "add"],
    ["devops", "invoke"],
  ])("passes only organization for %j", (...command) => {
    const args = scopeAzureDevOpsArgs([...command, "--detect", "true"], scope);
    expect(args).toContain(scope.organization);
    expect(args).not.toContain("--project");
    expect(args).not.toContain("--repository");
  });
  it("preserves explicit repository and project selections", () => {
    const args = scopeAzureDevOpsArgs(
      [
        "repos",
        "pr",
        "create",
        "--detect",
        "true",
        "--repository",
        "Other",
        "--project",
        "Other Project",
      ],
      scope,
    );
    expect(args.filter((arg) => arg === "--repository")).toHaveLength(1);
    expect(args.filter((arg) => arg === "--project")).toHaveLength(1);
    expect(args).toContain("Other Project");
  });
});
