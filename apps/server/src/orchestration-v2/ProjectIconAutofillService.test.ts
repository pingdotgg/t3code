import { assert, describe, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectIconAutofillService from "./ProjectIconAutofillService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const projectId = ProjectId.make("project:icon-autofill");
const workspaceRoot = "/repo" as const;

const storedIcon = { kind: "lucide", name: "terminal", color: "red" } as const;

const enabledSettings = {
  projectIconAutoFillEnabled: true,
  projectSettingsOverrides: { [projectId]: { projectIconAutoFillEnabled: true } },
} as const;

function storedProject(
  overrides: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly projectIcon?: typeof storedIcon | null;
    readonly faviconPath?: string | null;
  } = {},
) {
  return {
    projectId,
    title: overrides.title ?? "Autofill project",
    workspaceRoot: overrides.workspaceRoot ?? workspaceRoot,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: overrides.faviconPath ?? null,
    projectIcon: overrides.projectIcon ?? null,
    scripts: [],
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    deletedAt: null,
  };
}

function makeHarness(
  options: {
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    readonly baseDir?: string;
    readonly project?: ReturnType<typeof storedProject> | null;
    readonly racedIcon?: boolean;
  } = {},
) {
  const generateProjectIcon = vi.fn<
    TextGeneration.TextGeneration["Service"]["generateProjectIcon"]
  >((_input) => Effect.succeed({ name: "folder-code", color: "blue" }));
  const committed: Array<{ readonly projectIcon: unknown }> = [];
  let gets = 0;
  const project = options.project === undefined ? storedProject() : options.project;
  const layerProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (_requestedProjectId: ProjectId) => {
      gets += 1;
      if (project === null) return Effect.succeedNone;
      const current =
        options.racedIcon === true && gets > 1 ? { ...project, projectIcon: storedIcon } : project;
      return Effect.succeedSome(current);
    },
  });
  const layer = ProjectIconAutofillService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listProjectThreads: (_input: {
            readonly projectId?: ProjectId | undefined;
            readonly includeSubagents: boolean;
          }) =>
            Effect.succeed([
              { ...liveThreadShell(ThreadId.make("thread:icon-first")), title: "First thread" },
              { ...liveThreadShell(ThreadId.make("thread:icon-second")), title: "Second thread" },
              { ...liveThreadShell(ThreadId.make("thread:icon-new")), title: "New thread" },
            ]),
        }),
        layerProjects,
        Layer.mock(EventSink.EventSinkV2)({
          commitProjectCommand: (input) =>
            Effect.succeed({
              receipt: {
                commandId: input.commandId,
                projectId: input.projectId,
                commandType: input.commandType,
                acceptedAt: input.acceptedAt,
                resultSequence: 1,
                status: "accepted" as const,
                error: null,
              },
              committed: true,
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  committed.push({
                    projectIcon: (input.event as { readonly payload: unknown }).payload,
                  });
                }),
              ),
            ),
        }),
        IdAllocator.layer,
        ServerSettings.layerTest(options.settings ?? enabledSettings),
        Layer.mock(TextGeneration.TextGeneration)({ generateProjectIcon }),
      ),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), options.baseDir ?? { prefix: "icon-autofill-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, generateProjectIcon, committed };
}

const execute = Effect.gen(function* () {
  const service = yield* ProjectIconAutofillService.ProjectIconAutofillService;
  yield* service.execute({
    threadId: ThreadId.make("thread:icon-autofill"),
    commandId: CommandId.make("command:icon-autofill"),
    projectId,
  });
});

describe("ProjectIconAutofillService", () => {
  it.effect.each([
    { name: "disabled globally", settings: { projectIconAutoFillEnabled: false } },
    {
      name: "disabled for the project",
      settings: {
        projectIconAutoFillEnabled: true,
        projectSettingsOverrides: { [projectId]: { projectIconAutoFillEnabled: false } },
      },
    },
    {
      name: "existing icon",
      settings: enabledSettings,
      project: storedProject({ projectIcon: storedIcon }),
    },
    {
      name: "existing favicon",
      settings: enabledSettings,
      project: storedProject({ faviconPath: "/favicon.ico" }),
    },
    { name: "missing project", settings: enabledSettings, project: null },
  ])("skips when $name", ({ settings, ...rest }) =>
    Effect.gen(function* () {
      const harness = makeHarness({ settings, ...rest });
      yield* execute.pipe(Effect.provide(harness.layer));
      assert.equal(harness.generateProjectIcon.mock.calls.length, 0);
      assert.equal(harness.committed.length, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sets a lucide icon and color on the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "icon-autofill-" });
      yield* fs.writeFileString(`${tempRoot}/README.md`, "# Autofill project\n");
      yield* fs.writeFileString(`${tempRoot}/package.json`, '{"name":"autofill"}');
      const harness = makeHarness({ project: storedProject({ workspaceRoot: tempRoot }) });
      yield* execute.pipe(Effect.provide(harness.layer));
      const calls = harness.generateProjectIcon.mock.calls;
      assert.equal(calls.length, 1);
      const call = calls[0]?.[0];
      assert.equal(call?.projectTitle, "Autofill project");
      assert.deepEqual(call?.threadTitles, ["First thread", "Second thread"]);
      assert.include(call?.readmeExcerpt, "Autofill project");
      assert.include(call?.packageJsonExcerpt, "autofill");
      assert.equal(harness.committed.length, 1);
      const written = harness.committed[0];
      assert.isDefined(written);
      assert.deepEqual((written.projectIcon as { projectIcon: unknown }).projectIcon, {
        kind: "lucide",
        name: "folder-code",
        color: "blue",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("skips the write when an icon appears mid-flight", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ racedIcon: true });
      yield* execute.pipe(Effect.provide(harness.layer));
      assert.equal(harness.generateProjectIcon.mock.calls.length, 1);
      assert.equal(harness.committed.length, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("skips the scratch project", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "icon-autofill-base-" });
      const harness = makeHarness({
        baseDir,
        project: storedProject({
          title: "No project",
          workspaceRoot: path.join(baseDir, "scratch"),
        }),
      });
      yield* execute.pipe(Effect.provide(harness.layer));
      assert.equal(harness.generateProjectIcon.mock.calls.length, 0);
      assert.equal(harness.committed.length, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
