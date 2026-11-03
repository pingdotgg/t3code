import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { type McpServerConfig, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpServerTools from "./McpServerTools.ts";

const fixture = new URL("./testFixtures/two-tool-mcp-server.mjs", import.meta.url).pathname;

const stdioServer = (
  args: ReadonlyArray<string>,
  env: ReadonlyArray<{ readonly name: string; readonly value: string }> = [],
): McpServerConfig => ({
  enabled: true,
  transport: {
    type: "stdio",
    command: process.execPath,
    args: [...args],
    env: env.map((variable) => ({ ...variable, sensitive: false })),
  },
});

/** One registered project, checked out at `projectRoot`. */
const projects = (projectRoot: string | null) =>
  Layer.mock(ProjectService.ProjectService)({
    getByWorkspaceRoot: (root: string) =>
      Effect.succeed(
        root === projectRoot
          ? Option.some({
              id: ProjectId.make("project"),
              title: "Project",
              workspaceRoot: projectRoot,
            } as never)
          : Option.none(),
      ),
  });

const listTools = (
  settings: Parameters<typeof ServerSettings.layerTest>[0],
  input: Parameters<McpServerTools.McpServerTools["Service"]["listTools"]>[0],
  projectRoot: string | null = null,
) =>
  McpServerTools.McpServerTools.pipe(
    Effect.flatMap((service) => service.listTools(input)),
    Effect.provide(
      McpServerTools.layer.pipe(
        Layer.provide(ServerSettings.layerTest(settings)),
        Layer.provide(projects(projectRoot)),
      ),
    ),
  );

/** Whether a process with this pid is still running. */
const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.live("lists a stdio server's tools across pages, then stops it", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-tools-" });
    const pidFile = path.join(directory, "pid");

    const result = yield* listTools(
      {
        mcpServers: {
          fixture: stdioServer(
            [fixture],
            [
              { name: "MCP_FIXTURE_PID_FILE", value: pidFile },
              { name: "MCP_FIXTURE_GREETING", value: "Hello from env." },
            ],
          ),
        },
      },
      { name: "fixture" },
    );

    expect(result.serverInfo).toEqual({ name: "two-tool-fixture", version: "1.2.3" });
    expect(result.tools).toEqual([
      {
        name: "echo",
        title: "Echo",
        description: "Repeats text back. Hello from env.",
        parameters: [
          { name: "text", type: "string", description: "What to repeat", required: true },
          { name: "times", type: "integer", description: "How many times", required: false },
        ],
      },
      {
        name: "pick",
        description: "Picks a color.",
        parameters: [
          { name: "color", type: '"red" | "green"', required: true },
          { name: "tags", type: "string[]", required: false },
        ],
      },
    ]);

    const pid = Number(yield* fileSystem.readFileString(pidFile));
    expect(isRunning(pid)).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("lists a project's server that is switched off, started in the checkout", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const projectRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-project-" });
    // A relative path, which only resolves from the project's checkout.
    yield* fileSystem.copyFile(fixture, `${projectRoot}/server.mjs`);
    const result = yield* listTools(
      {
        projectSettingsOverrides: {
          [ProjectId.make("project")]: {
            mcpServers: { local: { ...stdioServer(["server.mjs"]), enabled: false } },
          },
        },
      },
      { name: "local", cwd: projectRoot },
      projectRoot,
    );
    expect(result.tools.map((tool) => tool.name)).toEqual(["echo", "pick"]);

    // The environment doesn't have the project's server.
    const outside = yield* listTools({}, { name: "local" }, projectRoot).pipe(Effect.flip);
    assert(outside._tag === "McpServerToolsError");
    expect(outside.reason).toBe("not-found");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("fails with a typed error when the command can't run or exits", () =>
  Effect.gen(function* () {
    const missing = yield* listTools(
      {
        mcpServers: {
          broken: {
            enabled: true,
            transport: {
              type: "stdio",
              command: "/definitely/not/a/command",
              args: [],
              env: [],
            },
          },
        },
      },
      { name: "broken" },
    ).pipe(Effect.flip);
    assert(missing._tag === "McpServerToolsError");
    expect(missing.reason).toBe("spawn-failed");

    const exits = yield* listTools(
      { mcpServers: { exits: stdioServer(["-e", "process.exit(3)"]) } },
      { name: "exits" },
    ).pipe(Effect.flip);
    assert(exits._tag === "McpServerToolsError");
    expect(exits.reason).toBe("exited");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a server or project that isn't there", () =>
  Effect.gen(function* () {
    const unknown = yield* listTools({}, { name: "nope" }).pipe(Effect.flip);
    assert(unknown._tag === "McpServerToolsError");
    expect(unknown.reason).toBe("not-found");

    const project = yield* listTools({}, { name: "nope", cwd: "/elsewhere" }).pipe(Effect.flip);
    assert(project._tag === "McpServerToolsError");
    expect(project.reason).toBe("unknown-project");
  }),
);

it.effect("lists T3 Code's own tools without starting anything", () =>
  Effect.gen(function* () {
    const result = yield* listTools({}, { name: "t3-code" });
    expect(result.serverInfo?.name).toBe("T3 Code");
    const names = result.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "t3_thread_launch",
        "delegate_task",
        "preview_snapshot",
        "html_render",
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
    const launch = result.tools.find((tool) => tool.name === "t3_thread_launch");
    expect(launch?.description).toBeTruthy();
    expect(launch?.parameters.some((parameter) => parameter.name === "title")).toBe(true);
  }),
);
