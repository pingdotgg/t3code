import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, SkillListResult, type Project, type SkillSummary } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import * as SkillCatalog from "./SkillCatalog.ts";
import { RegisteredProjects, restoreLibraryLinks } from "./SkillLibrary.ts";

const encodeList = Schema.encodeUnknownEffect(SkillListResult);

const skillFile = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n`;

/**
 * A machine with a library holding `db-migrations` (a real folder) and `alpha` (a link to a synced
 * folder), three projects that link to some of them, and a project that isn't registered.
 */
const makeMachine = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3code-library-" }));
  const write = (relative: string, contents: string) =>
    Effect.gen(function* () {
      const target = path.join(home, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
    });
  const link = (target: string, from: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(path.join(home, from)), { recursive: true });
      yield* fs.symlink(target, path.join(home, from));
    });
  const library = path.join(home, ".agents/skill-library");
  const projects = ["acme-web", "acme-api", "marketing-site", "stranger"].map((name) =>
    path.join(home, "repos", name),
  );
  const [web, api, marketing, stranger] = projects as [string, string, string, string];

  yield* write(".agents/skill-library/db-migrations/SKILL.md", skillFile("db-migrations"));
  yield* write("Knowledge/skills/alpha/SKILL.md", skillFile("alpha"));
  yield* link(path.join(home, "Knowledge/skills/alpha"), ".agents/skill-library/alpha");
  yield* write("repos/acme-web/elsewhere/solo/SKILL.md", skillFile("solo"));

  // web and api use db-migrations; web also uses alpha; stranger isn't registered.
  for (const project of [web, api, stranger]) {
    yield* link(
      path.join(library, "db-migrations"),
      path.relative(home, path.join(project, ".agents/skills/db-migrations")),
    );
  }
  yield* link(
    path.join(library, "alpha"),
    path.relative(home, path.join(web, ".agents/skills/alpha")),
  );
  // A link to a skill that isn't the library's is the project's own.
  yield* link(
    path.join(web, "elsewhere/solo"),
    path.relative(home, path.join(web, ".agents/skills/solo")),
  );
  yield* fs.makeDirectory(marketing, { recursive: true });
  return { fs, path, home, write, library, web, api, marketing, stranger };
});

const makeProject = (workspaceRoot: string): Project => ({
  id: ProjectId.make("project-skill-library"),
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

const onMachine = <A, E, R>(
  home: string,
  registered: readonly string[],
  use: (catalog: SkillCatalog.SkillCatalog["Service"]) => Effect.Effect<A, E, R>,
  environment: NodeJS.ProcessEnv = {},
) =>
  Effect.gen(function* () {
    return yield* use(yield* SkillCatalog.SkillCatalog);
  }).pipe(
    Effect.provide(
      SkillCatalog.layer.pipe(
        Layer.provide(Settings.layerTest({})),
        Layer.provide(
          Layer.mock(ProjectService.ProjectService)({
            getByWorkspaceRoot: (root) =>
              Effect.succeed(
                registered.includes(root) ? Option.some(makeProject(root)) : Option.none(),
              ),
          }),
        ),
      ),
    ),
    Effect.provideService(HostProcess.Environment, { HOME: home, ...environment }),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(RegisteredProjects, Effect.succeed(registered)),
  );

const rowOf = (skills: readonly SkillSummary[], scope: SkillSummary["scope"], name: string) =>
  skills.find((skill) => skill.scope === scope && skill.name === name);

const statesOf = (row: SkillSummary | undefined) =>
  row === undefined
    ? undefined
    : Object.fromEntries(row.access.map((access) => [access.instanceId, access.state]));

it.layer(NodeServices.layer, { excludeTestServices: true })("SkillLibrary", (it) => {
  describe("the list", () => {
    it.effect.skipIf(!symlinksSupported)(
      "shows library skills as Global, with the registered projects that link to them",
      () =>
        Effect.gen(function* () {
          const { home, web, api, marketing } = yield* makeMachine;
          yield* onMachine(home, [marketing, api, web], (catalog) =>
            Effect.gen(function* () {
              const result = yield* catalog.list({});
              yield* encodeList(result);

              const migrations = rowOf(result.skills, "global", "db-migrations");
              expect(migrations).toMatchObject({
                home: "~/.agents/skill-library/db-migrations",
                realFolder: true,
              });
              // In the order the projects were given; the unregistered one isn't named.
              expect(migrations?.projects).toEqual([api, web]);
              expect(rowOf(result.skills, "global", "alpha")?.projects).toEqual([web]);
              // A synced skill's folder stays where it is, so T3 Code can't move or delete it.
              expect(rowOf(result.skills, "global", "alpha")).toMatchObject({
                home: "~/Knowledge/skills/alpha",
              });
              expect(rowOf(result.skills, "global", "alpha")?.realFolder).toBeUndefined();
              // No agent reads the library; each has what the projects' links give it, across all
              // of them. Codex reads the shared folder the links are in. Claude reads its own,
              // where nothing is linked yet.
              for (const name of ["db-migrations", "alpha"]) {
                expect(statesOf(rowOf(result.skills, "global", name))).toEqual({
                  claudeAgent: "none",
                  codex: "direct",
                });
              }
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "shows a project's link to a library skill as that Global skill, not as the project's own",
      () =>
        Effect.gen(function* () {
          const { home, web, api, marketing } = yield* makeMachine;
          yield* onMachine(home, [web, api, marketing], (catalog) =>
            Effect.gen(function* () {
              const inWeb = (yield* catalog.list({ cwd: web })).skills;

              expect(
                inWeb.filter((skill) => skill.name === "db-migrations").map((skill) => skill.scope),
              ).toEqual(["global"]);
              expect(rowOf(inWeb, "global", "db-migrations")?.projects).toEqual([web, api]);
              // The project reads its folder, so the agents that read it have the skill here.
              expect(
                rowOf(inWeb, "global", "db-migrations")?.access.find(
                  (access) => access.instanceId === "codex",
                )?.state,
              ).toBe("direct");
              // Its own skill, linked the same way, is still its own.
              expect(rowOf(inWeb, "project", "solo")).toBeDefined();

              // A project that doesn't link to it sees the same Global skill, with the same
              // agents: they are the skill's, not the project's.
              const inMarketing = (yield* catalog.list({ cwd: marketing })).skills;
              expect(rowOf(inMarketing, "global", "db-migrations")?.projects).toEqual([web, api]);
              expect(statesOf(rowOf(inMarketing, "global", "db-migrations"))).toEqual(
                statesOf(rowOf(inWeb, "global", "db-migrations")),
              );
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "names no projects when none is registered or none links to the skill",
      () =>
        Effect.gen(function* () {
          const { home, marketing } = yield* makeMachine;
          yield* onMachine(home, [marketing], (catalog) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({});

              expect(rowOf(skills, "global", "db-migrations")).toBeDefined();
              expect(rowOf(skills, "global", "db-migrations")?.projects).toBeUndefined();
            }),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "gives a skill its source from the skills CLI's lock, in the project and in Global",
      () =>
        Effect.gen(function* () {
          const { home, web, write } = yield* makeMachine;
          yield* write(
            "repos/acme-web/skills-lock.json",
            JSON.stringify({
              version: 1,
              skills: {
                solo: { source: "acme/skills", sourceType: "github", computedHash: "x" },
              },
            }),
          );
          yield* write(
            "state/skills/.skill-lock.json",
            JSON.stringify({
              version: 3,
              skills: {
                "db-migrations": {
                  source: "acme/migrations",
                  sourceType: "github",
                  sourceUrl: "https://github.com/acme/migrations.git",
                  skillFolderHash: "",
                  installedAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              },
            }),
          );
          yield* onMachine(
            home,
            [web],
            (catalog) =>
              Effect.gen(function* () {
                const { skills } = yield* catalog.list({ cwd: web });

                expect(rowOf(skills, "project", "solo")?.source).toBe("acme/skills");
                expect(rowOf(skills, "global", "db-migrations")?.source).toBe("acme/migrations");
                expect(rowOf(skills, "global", "alpha")?.source).toBeUndefined();
              }),
            { XDG_STATE_HOME: `${home}/state` },
          );
        }),
    );
  });

  describe("restoreLibraryLinks", () => {
    it.effect.skipIf(!symlinksSupported)(
      "makes the same links in a worktree, keeping out of the way of what is there",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, library, web } = yield* makeMachine;
          const worktree = path.join(home, "worktrees/acme-web-feature");
          yield* fs.makeDirectory(path.join(worktree, ".agents/skills/alpha"), { recursive: true });
          yield* fs.writeFileString(path.join(worktree, ".agents/skills/alpha/SKILL.md"), "kept");

          yield* restoreLibraryLinks({ project: web, worktree, prefix: "" }).pipe(
            Effect.provideService(HostProcess.HomeDirectory, home),
          );

          expect(yield* fs.readLink(path.join(worktree, ".agents/skills/db-migrations"))).toBe(
            path.join(library, "db-migrations"),
          );
          // Something already there stays, and the project's own links aren't copied.
          expect(
            yield* fs.readFileString(path.join(worktree, ".agents/skills/alpha/SKILL.md")),
          ).toBe("kept");
          expect(yield* fs.exists(path.join(worktree, ".agents/skills/solo"))).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "makes the links in the project's own folder of a worktree of the whole repository",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, library, web } = yield* makeMachine;
          const worktree = path.join(home, "worktrees/monorepo-feature");

          // The project is `apps/web` of its repository, and the worktree is the repository.
          yield* restoreLibraryLinks({ project: web, worktree, prefix: "apps/web/" }).pipe(
            Effect.provideService(HostProcess.HomeDirectory, home),
          );

          expect(
            yield* fs.readLink(path.join(worktree, "apps/web/.agents/skills/db-migrations")),
          ).toBe(path.join(library, "db-migrations"));
          expect(yield* fs.exists(path.join(worktree, ".agents"))).toBe(false);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "writes a relative project link as the library skill's own path",
      () =>
        Effect.gen(function* () {
          const { fs, path, home, library } = yield* makeMachine;
          const project = path.join(home, "repos/relative");
          const link = path.join(project, ".agents/skills/db-migrations");
          yield* fs.makeDirectory(path.dirname(link), { recursive: true });
          yield* fs.symlink(
            path.relative(path.dirname(link), path.join(library, "db-migrations")),
            link,
          );
          // A depth where the project link's relative target would lead somewhere else.
          const worktree = path.join(home, "worktrees/deeper/still/relative-feature");

          yield* restoreLibraryLinks({ project, worktree, prefix: "" }).pipe(
            Effect.provideService(HostProcess.HomeDirectory, home),
          );

          const created = path.join(worktree, ".agents/skills/db-migrations");
          expect(yield* fs.readLink(created)).toBe(path.join(library, "db-migrations"));
          expect(yield* fs.exists(path.join(created, "SKILL.md"))).toBe(true);
        }),
    );

    it.effect("does nothing for a project without links, or one that has gone", () =>
      Effect.gen(function* () {
        const { fs, path, home, marketing } = yield* makeMachine;
        const worktree = path.join(home, "worktrees/marketing-feature");

        yield* restoreLibraryLinks({ project: marketing, worktree, prefix: "" }).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
        yield* restoreLibraryLinks({
          project: path.join(home, "repos/gone"),
          worktree,
          prefix: "",
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));

        expect(yield* fs.exists(worktree)).toBe(false);
      }),
    );
  });
});
