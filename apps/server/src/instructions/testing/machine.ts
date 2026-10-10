/**
 * A made-up machine for instruction tests: a temp home folder with real files and links, a project
 * in it, and the instruction services running over it. Only what lives outside the files is a
 * stand-in: the provider snapshots (versions), the project registry, and the project's file index,
 * which walks the real folder.
 */
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type Project,
  type ServerProvider,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as Settings from "../../serverSettings.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as InstructionCatalog from "../InstructionCatalog.ts";
import * as InstructionManager from "../InstructionManager.ts";
import * as InstructionTracking from "../InstructionTracking.ts";

export const agent = ProviderInstanceId.make;

/** Every agent that has instruction files, by instance id. */
export const ALL_AGENTS = [
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "pi",
];

export const makeProject = (workspaceRoot: string): Project => ({
  id: ProjectId.make("project-instructions"),
  title: "App",
  workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
});

/** The machine's own project, in its home folder. */
const PROJECT_FOLDER = "repos/app";

/** A temp home folder, with helpers to put files and links in it, and a project folder. */
export const makeMachine = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3code-instructions-" }),
  );
  const project = path.join(home, PROJECT_FOLDER);
  yield* fs.makeDirectory(project, { recursive: true });
  const write = (relative: string, contents: string) =>
    Effect.gen(function* () {
      const target = path.join(home, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
    });
  const link = (target: string, from: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(path.join(home, from)), { recursive: true });
      yield* fs.symlink(path.join(home, target), path.join(home, from));
    });
  const read = (relative: string) => fs.readFileString(path.join(home, relative));
  return { fs, path, home, project, write, link, read };
});

export interface MachineOptions {
  /** Folders that are projects; the machine's own project when absent. */
  readonly registered?: readonly string[];
  /** Claude Code's version, by instance id; absent means the status has no version. */
  readonly versions?: Readonly<Record<string, string>>;
  /** Extra enabled providers beyond the default Claude and Codex. */
  readonly providers?: readonly string[];
  readonly providerInstances?: NonNullable<
    Parameters<typeof Settings.layerTest>[0]
  >["providerInstances"];
  /** Environment variables of the server process, besides HOME. */
  readonly env?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
}

const snapshotOf = (
  instanceId: string,
  driver: string,
  version: string | null,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

/**
 * The instruction services on a machine whose home is `home`. The file index is a walk of the real
 * project folder that matches names exactly, skipping `.git` and `node_modules`.
 */
export const layerFor = (home: string, options: MachineOptions = {}) => {
  const sameFolder = (a: string, b: string) => a.replaceAll("\\", "/") === b.replaceAll("\\", "/");
  const isProject = (root: string) =>
    options.registered === undefined
      ? sameFolder(root, `${home}/${PROJECT_FOLDER}`)
      : options.registered.some((folder) => sameFolder(folder, root));
  const versions = options.versions ?? {};
  const enabled = Object.fromEntries(
    (options.providers ?? ["cursor", "grok", "opencode", "antigravity", "pi"]).map((id) => [
      ProviderInstanceId.make(id),
      { driver: ProviderDriverKind.make(id), enabled: true },
    ]),
  );
  const settings = Settings.layerTest({
    providerInstances: { ...enabled, ...options.providerInstances },
  });
  const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed([
      snapshotOf("claudeAgent", "claudeAgent", versions.claudeAgent ?? null),
      ...Object.entries(versions)
        .filter(([id]) => id !== "claudeAgent")
        .map(([id, version]) => snapshotOf(id, "claudeAgent", version)),
    ]),
  });
  const projects = Layer.mock(ProjectService.ProjectService)({
    getByWorkspaceRoot: (root) =>
      Effect.succeed(isProject(root) ? Option.some(makeProject(root)) : Option.none()),
  });
  const index = Layer.effect(
    WorkspaceEntries.WorkspaceEntries,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return WorkspaceEntries.WorkspaceEntries.of({
        ...({} as WorkspaceEntries.WorkspaceEntries["Service"]),
        search: (input) =>
          fs.readDirectory(input.cwd, { recursive: true }).pipe(
            Effect.map((paths) => ({
              entries: paths
                .map((entry) => entry.replaceAll("\\", "/"))
                .filter(
                  (entry) =>
                    !entry.split("/").some((part) => part === ".git" || part === "node_modules") &&
                    entry.split("/").at(-1) === input.query,
                )
                .toSorted()
                .slice(0, input.limit)
                .map((entry) => ({ path: entry, kind: "file" as const })),
              truncated: false,
            })),
            Effect.orDie,
          ),
      });
    }),
  );
  const catalog = InstructionCatalog.layer.pipe(
    Layer.provide(settings),
    Layer.provide(registry),
    Layer.provide(index),
  );
  return Layer.mergeAll(InstructionManager.layer, InstructionTracking.layer).pipe(
    Layer.provideMerge(catalog),
    Layer.provide(projects),
    Layer.provide(VcsProcess.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Environment, { HOME: home, ...options.env }),
        Layer.succeed(HostProcess.HomeDirectory, home),
        Layer.succeed(HostProcess.Platform, options.platform ?? "linux"),
      ),
    ),
  );
};
