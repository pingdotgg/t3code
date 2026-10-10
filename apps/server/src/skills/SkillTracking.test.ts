import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  SkillRequestError,
  type Project,
  type SkillRef,
  type SkillScope,
  type SkillSummary,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Settings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SkillCatalog from "./SkillCatalog.ts";
import * as SkillTracking from "./SkillTracking.ts";

const skillFile = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n`;

/** A project with three skills of its own and one that is only linked in, plus a global skill. */
const makeMachine = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3code-skill-tracking-" }),
  );
  const project = path.join(home, "repos/app");
  const write = (relative: string, contents: string) =>
    Effect.gen(function* () {
      const target = path.join(home, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
    });
  yield* write("repos/app/.agents/skills/verify/SKILL.md", skillFile("verify"));
  yield* write("repos/app/.claude/skills/own-copy/SKILL.md", skillFile("own-copy"));
  yield* write("repos/app/.agents/skills/tdd/SKILL.md", skillFile("tdd"));
  yield* write(".claude/skills/cloudflare/SKILL.md", skillFile("cloudflare"));
  yield* write("library/relay/SKILL.md", skillFile("relay"));
  yield* fs.symlink(path.join(home, "library/relay"), path.join(project, ".agents/skills/relay"));
  return { home, project };
});

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: [
        "-C",
        cwd,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

const makeProject = (workspaceRoot: string): Project => ({
  id: ProjectId.make("project-skill-tracking"),
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

/**
 * The skill list and the tracking check, on a machine whose home is `home`. Only the `registered`
 * folders are projects; by default that is the machine's `repos/app`.
 */
const onMachine = <A, E, R>(
  home: string,
  use: (services: {
    readonly catalog: SkillCatalog.SkillCatalog["Service"];
    readonly tracking: SkillTracking.SkillTracking["Service"];
  }) => Effect.Effect<A, E, R>,
  registered?: readonly string[],
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const roots = registered ?? [path.join(home, "repos/app")];
    const projects = Layer.mock(ProjectService.ProjectService)({
      getByWorkspaceRoot: (root) =>
        Effect.succeed(roots.includes(root) ? Option.some(makeProject(root)) : Option.none()),
    });
    return yield* Effect.gen(function* () {
      return yield* use({
        catalog: yield* SkillCatalog.SkillCatalog,
        tracking: yield* SkillTracking.SkillTracking,
      });
    }).pipe(
      Effect.provide(
        SkillTracking.layer.pipe(
          Layer.provideMerge(SkillCatalog.layer.pipe(Layer.provide(Settings.layerTest({})))),
          Layer.provide(projects),
          Layer.provide(VcsProcess.layer),
        ),
      ),
    );
  }).pipe(
    Effect.provideService(HostProcess.Environment, { HOME: home }),
    Effect.provideService(HostProcess.HomeDirectory, home),
  );

const refOf = (skills: readonly SkillSummary[], scope: SkillScope, name: string): SkillRef => {
  const skill = skills.find((item) => item.scope === scope && item.name === name);
  if (!skill) throw new Error(`No ${scope} skill ${name} in the list`);
  return { scope, name, home: skill.home };
};

it.layer(NodeServices.layer, { excludeTestServices: true })("SkillTracking", (it) => {
  describe("tracked", () => {
    it.effect("names the project skills that git tracks, and only those", () =>
      Effect.gen(function* () {
        const { home, project } = yield* makeMachine;
        yield* git(project, ["init"]);
        yield* git(project, ["add", ".agents/skills/verify", ".claude/skills/own-copy"]);
        yield* git(project, ["commit", "-m", "skills"]);
        const result = yield* onMachine(home, ({ catalog, tracking }) =>
          Effect.gen(function* () {
            const { skills } = yield* catalog.list({ cwd: project });
            return yield* tracking.tracked({
              cwd: project,
              skills: ["verify", "own-copy", "tdd"].map((name) => refOf(skills, "project", name)),
            });
          }),
        );

        // `tdd` is in the repo but was never added.
        expect([...result.tracked].toSorted()).toEqual(["own-copy", "verify"]);
      }),
    );

    it.effect("never counts a global skill, even when it is asked about", () =>
      Effect.gen(function* () {
        const { home, project } = yield* makeMachine;
        yield* git(project, ["init"]);
        yield* git(project, ["add", "."]);
        yield* git(project, ["commit", "-m", "everything"]);
        const result = yield* onMachine(home, ({ catalog, tracking }) =>
          Effect.gen(function* () {
            const { skills } = yield* catalog.list({ cwd: project });
            return yield* tracking.tracked({
              cwd: project,
              skills: [refOf(skills, "global", "cloudflare"), refOf(skills, "project", "verify")],
            });
          }),
        );

        expect(result.tracked).toEqual(["verify"]);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "doesn't count a skill that is only reached through a link",
      () =>
        Effect.gen(function* () {
          const { home, project } = yield* makeMachine;
          yield* git(project, ["init"]);
          yield* git(project, ["add", "."]);
          yield* git(project, ["commit", "-m", "everything"]);
          const result = yield* onMachine(home, ({ catalog, tracking }) =>
            Effect.gen(function* () {
              const { skills } = yield* catalog.list({ cwd: project });
              return yield* tracking.tracked({
                cwd: project,
                skills: ["relay", "verify"].map((name) => refOf(skills, "project", name)),
              });
            }),
          );

          expect(result.tracked).toEqual(["verify"]);
        }),
    );

    it.effect("skips a skill that is no longer where the client said", () =>
      Effect.gen(function* () {
        const { home, project } = yield* makeMachine;
        yield* git(project, ["init"]);
        yield* git(project, ["add", "."]);
        yield* git(project, ["commit", "-m", "everything"]);
        const result = yield* onMachine(home, ({ catalog, tracking }) =>
          Effect.gen(function* () {
            const { skills } = yield* catalog.list({ cwd: project });
            return yield* tracking.tracked({
              cwd: project,
              skills: [
                { ...refOf(skills, "project", "verify"), home: "~/elsewhere/verify" },
                { scope: "project", name: "missing", home: ".agents/skills/missing" },
                refOf(skills, "project", "tdd"),
              ],
            });
          }),
        );

        expect(result.tracked).toEqual(["tdd"]);
      }),
    );

    it.effect("refuses a folder that isn't a registered project, without running git", () =>
      Effect.gen(function* () {
        const { home, project } = yield* makeMachine;
        yield* git(project, ["init"]);
        yield* git(project, ["add", "."]);
        yield* git(project, ["commit", "-m", "everything"]);
        const skills = [
          { scope: "project", name: "verify", home: ".agents/skills/verify" },
        ] as const;
        const refused = yield* onMachine(
          home,
          ({ tracking }) => tracking.tracked({ cwd: project, skills }).pipe(Effect.flip),
          [],
        );
        expect(refused).toEqual(new SkillRequestError({ reason: "projectNotRegistered" }));

        // The same folder is read once it is a project.
        const result = yield* onMachine(home, ({ tracking }) =>
          tracking.tracked({ cwd: project, skills }),
        );
        expect(result.tracked).toEqual(["verify"]);
      }),
    );

    it.effect("tracks nothing outside a git repository", () =>
      Effect.gen(function* () {
        const { home, project } = yield* makeMachine;
        const result = yield* onMachine(home, ({ catalog, tracking }) =>
          Effect.gen(function* () {
            const { skills } = yield* catalog.list({ cwd: project });
            return yield* tracking.tracked({
              cwd: project,
              skills: [refOf(skills, "project", "verify")],
            });
          }),
        );

        expect(result.tracked).toEqual([]);
      }),
    );
  });
});
