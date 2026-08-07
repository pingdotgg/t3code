import { describe, expect, it } from "vite-plus/test";

import { cloudCloneDestination, cloudEnvironmentProvider } from "./cloudEnvironment";

describe("cloudEnvironmentProvider", () => {
  it("uses advertised Render metadata", () => {
    expect(
      cloudEnvironmentProvider({
        displayUrl: null,
        serverConfig: {
          environment: {
            environmentId: "environment-1",
            label: "Render cloud environment",
            platform: { os: "linux", arch: "x64" },
            cloud: { provider: "render", workspaceRoot: "/data/workspace" },
            serverVersion: "1.0.0",
            capabilities: { repositoryIdentity: true },
          },
        } as never,
      }),
    ).toBe("render");
  });

  it("recognizes disconnected onrender.com environments", () => {
    expect(
      cloudEnvironmentProvider({
        displayUrl: "https://t3code-cloud-demo.onrender.com",
        serverConfig: null,
      }),
    ).toBe("render");
  });
});

describe("cloudCloneDestination", () => {
  it("clones provider repositories under the cloud workspace root", () => {
    expect(
      cloudCloneDestination({
        workspaceRoot: "/data/workspace/",
        repository: {
          provider: "github",
          nameWithOwner: "shivamhwp/render-ad",
          url: "https://github.com/shivamhwp/render-ad",
          sshUrl: "git@github.com:shivamhwp/render-ad.git",
        },
        remoteUrl: "git@github.com:shivamhwp/render-ad.git",
      }),
    ).toBe("/data/workspace/render-ad");
  });

  it("derives a directory from arbitrary Git URLs", () => {
    expect(
      cloudCloneDestination({
        workspaceRoot: "/data/workspace",
        repository: null,
        remoteUrl: "https://example.com/team/project.git?ref=main",
      }),
    ).toBe("/data/workspace/project");
  });
});
