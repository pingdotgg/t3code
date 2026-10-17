import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { pullRequestFallbackEnvironment } from "./pullRequestEnvironmentFallback";

const project = (environmentId: string, id: string, canonicalKey: string) =>
  ({
    environmentId,
    id,
    repositoryIdentity: { canonicalKey },
  }) as unknown as EnvironmentProject;

const workspace = (environmentId: string, id: string, keys: ReadonlyArray<string>) => ({
  ...project(environmentId, id, "unused"),
  repositoryIdentity: null,
  workspaceRepositories: keys.map((key) => project(environmentId, id, key).repositoryIdentity!),
});

const projects = [
  project("laptop", "t3", "github.com/pingdotgg/t3code"),
  project("desktop", "other", "github.com/pingdotgg/other"),
  project("server", "t3-copy", "github.com/pingdotgg/t3code"),
];
const target = {
  environmentId: "laptop",
  projectId: "t3",
  repository: "pingdotgg/t3code",
  host: "github.com",
};
const environment = (
  environmentId: string,
  connectionState: EnvironmentConnectionPhase = "connected",
  isEnabled = true,
) => ({ environmentId: EnvironmentId.make(environmentId), connectionState, isEnabled });

describe("pullRequestFallbackEnvironment", () => {
  it("moves to a connected copy of the repository when the original is down", () => {
    expect(
      pullRequestFallbackEnvironment(target, projects, [
        environment("desktop"),
        environment("server"),
      ]),
    ).toEqual({ environmentId: "server", projectId: "t3-copy" });
  });

  it("stays put while the original is connected or nothing else holds the repository", () => {
    expect(
      pullRequestFallbackEnvironment(target, projects, [
        environment("laptop"),
        environment("server"),
      ]),
    ).toBe(null);
    expect(pullRequestFallbackEnvironment(target, projects, [environment("desktop")])).toBe(null);
  });

  it("derives the host from the original project when the route has none", () => {
    const { host: _host, ...hostless } = target;
    expect(pullRequestFallbackEnvironment(hostless, projects, [environment("server")])).toEqual({
      environmentId: "server",
      projectId: "t3-copy",
    });
  });

  it("finds a connected workspace checkout of a repository opened from another workspace", () => {
    const { host: _host, ...hostless } = target;
    const workspaces = [
      workspace("laptop", "t3", ["gitlab.com/team/other", "github.com/pingdotgg/t3code"]),
      workspace("wrong-host", "copy", ["github.acme.test/pingdotgg/t3code"]),
      workspace("server", "t3-copy", ["github.com/pingdotgg/t3code"]),
    ];
    expect(
      pullRequestFallbackEnvironment(hostless, workspaces, [
        environment("wrong-host"),
        environment("server"),
      ]),
    ).toEqual({ environmentId: "server", projectId: "t3-copy" });
  });

  it("finds a workspace copy when the original project is rooted in the repository", () => {
    expect(
      pullRequestFallbackEnvironment(
        target,
        [projects[0]!, workspace("server", "workspace", ["github.com/pingdotgg/t3code"])],
        [environment("server")],
      ),
    ).toEqual({ environmentId: "server", projectId: "workspace" });
  });

  it("requires a route host when the original workspace holds the repository on two hosts", () => {
    const { host: _host, ...hostless } = target;
    const copies = [
      workspace("laptop", "t3", [
        "github.com/pingdotgg/t3code",
        "github.acme.test/pingdotgg/t3code",
      ]),
      workspace("server", "copy", ["github.com/pingdotgg/t3code"]),
    ];
    expect(pullRequestFallbackEnvironment(hostless, copies, [environment("server")])).toBe(null);
    expect(pullRequestFallbackEnvironment(target, copies, [environment("server")])).toEqual({
      environmentId: "server",
      projectId: "copy",
    });
  });
});
