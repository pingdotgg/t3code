import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Project } from "../types";
import { resolveNewThreadProject } from "./piExternalProjects";

const environmentId = EnvironmentId.make("local");
const project = (id: string, workspaceRoot: string): Project =>
  ({
    environmentId,
    id: ProjectId.make(id),
    title: workspaceRoot.split("/").at(-1)!,
    workspaceRoot,
  }) as Project;

describe("resolveNewThreadProject", () => {
  it("promotes a catalog-only native Pi project", () => {
    const external = project("external:pi-project:abc", "/workspace/wazzaflow");

    expect(
      resolveNewThreadProject([external], scopeProjectRef(environmentId, external.id)),
    ).toEqual({ kind: "promote", project: external });
  });

  it("uses the persisted project when the native catalog still contains a duplicate", () => {
    const external = project("external:pi-project:abc", "/workspace/wazzaflow");
    const internal = project("project-1", "/workspace/wazzaflow");

    expect(
      resolveNewThreadProject([external, internal], scopeProjectRef(environmentId, external.id)),
    ).toEqual({
      kind: "internal",
      project: internal,
      projectRef: scopeProjectRef(environmentId, internal.id),
    });
  });
});
