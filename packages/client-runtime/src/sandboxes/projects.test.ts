import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ensureSandboxProject } from "./projects.ts";

describe("ensureSandboxProject", () => {
  const environmentId = EnvironmentId.make("env-worker");
  const input = { name: "worker", environmentId, workingDirectory: "/home/agent/code" };

  function dependencies(options: {
    readonly existing?: boolean;
    readonly createError?: string;
    /** Another window made the project meanwhile, so this create fails. */
    readonly madeElsewhere?: boolean;
  }) {
    let exists = options.existing === true;
    const created: string[] = [];
    return {
      created,
      dependencies: {
        hasProjectAt: () => exists,
        createProject: async (project: {
          readonly title: string;
          readonly workspaceRoot: string;
        }) => {
          created.push(`${project.title} at ${project.workspaceRoot}`);
          if (options.madeElsewhere) exists = true;
          return options.createError ?? null;
        },
      },
    };
  }

  it("makes one project at the working directory, named after the Agent", async () => {
    const deps = dependencies({});
    expect(await ensureSandboxProject(deps.dependencies, input)).toBeNull();
    expect(deps.created).toEqual(["worker at /home/agent/code"]);
  });

  it("leaves an existing project alone", async () => {
    const deps = dependencies({ existing: true });
    expect(await ensureSandboxProject(deps.dependencies, input)).toBeNull();
    expect(deps.created).toEqual([]);
  });

  it("succeeds when another window made the project first", async () => {
    const deps = dependencies({ createError: "workspace in use", madeElsewhere: true });
    expect(await ensureSandboxProject(deps.dependencies, input)).toBeNull();
  });

  it("reports a create that failed for another reason", async () => {
    const deps = dependencies({ createError: "no such directory" });
    expect(await ensureSandboxProject(deps.dependencies, input)).toBe("no such directory");
  });
});
