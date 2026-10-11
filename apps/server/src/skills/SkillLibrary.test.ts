import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SkillLibrary from "./SkillLibrary.ts";
import { lockedInstallSource } from "./SkillLibrary.ts";

const SKILL = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name}.\n`;

const claude: ServerProvider = {
  driver: ProviderDriverKind.make("claudeAgent"),
  instanceId: ProviderInstanceId.make("claude"),
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "ready",
  checkedAt: "2026-10-09T00:00:00Z",
  auth: { status: "authenticated" },
  models: [],
  skills: [],
  slashCommands: [],
};

/**
 * A temp HOME, a registered project and a local source with two skills (one
 * with a script), plus the service built against them. The real `skills` CLI
 * runs through the `t3 skills-cli` subcommand of this checkout's bin.ts.
 */
const withLibrary = <A, E>(
  body: (input: {
    readonly library: SkillLibrary.SkillLibrary["Service"];
    readonly home: string;
    readonly project: string;
    readonly source: string;
    readonly providers: Ref.Ref<ReadonlyArray<ServerProvider>>;
    readonly refreshed: Ref.Ref<ReadonlyArray<string>>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skill-library-" });
    const home = path.join(base, "home");
    const project = path.join(base, "project");
    const source = path.join(base, "source");
    yield* fileSystem.makeDirectory(home, { recursive: true });
    yield* fileSystem.makeDirectory(project, { recursive: true });
    yield* fileSystem.makeDirectory(path.join(source, "review", "bin"), { recursive: true });
    yield* fileSystem.makeDirectory(path.join(source, "notes"), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(source, "review", "SKILL.md"),
      SKILL("review", "Review a change."),
    );
    yield* fileSystem.writeFileString(path.join(source, "review", "bin", "run"), "#!/bin/sh\n");
    yield* fileSystem.chmod(path.join(source, "review", "bin", "run"), 0o755);
    yield* fileSystem.writeFileString(
      path.join(source, "notes", "SKILL.md"),
      SKILL("notes", "Take notes."),
    );
    // A name that isn't a folder name: the CLI installs it into `git-review`.
    yield* fileSystem.makeDirectory(path.join(source, "gitreview"), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(source, "gitreview", "SKILL.md"),
      SKILL("Git Review", "Review with git."),
    );

    const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([claude]);
    const refreshed = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (entry: string) =>
      Ref.update(refreshed, (entries) => [...entries, entry]).pipe(
        Effect.andThen(Ref.get(providers)),
      );
    // Folders being scanned right now: a second scan of one is an overlap.
    const scanning = yield* Ref.make<ReadonlyArray<string>>([]);
    const scan = (instanceId: string, cwd: string) =>
      Ref.get(scanning).pipe(
        Effect.tap((busy) => (busy.includes(cwd) ? record(`overlap:${cwd}`) : Effect.void)),
        Effect.andThen(Ref.update(scanning, (busy) => [...busy, cwd])),
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(record(`workspace:${instanceId}:${cwd}`)),
        Effect.ensuring(
          Ref.update(scanning, (busy) => {
            const index = busy.indexOf(cwd);
            return index === -1 ? busy : [...busy.slice(0, index), ...busy.slice(index + 1)];
          }),
        ),
      );
    const stub: Pick<
      ProviderRegistry.ProviderRegistry["Service"],
      "getProviders" | "refreshInstance" | "refreshWorkspaceSnapshot"
    > = {
      getProviders: Ref.get(providers),
      refreshInstance: (instanceId) => record(`instance:${instanceId}`),
      refreshWorkspaceSnapshot: ({ instanceId, cwd, fresh }) =>
        record(`fresh:${instanceId}:${cwd}:${fresh === true}`).pipe(
          Effect.andThen(scan(instanceId, cwd)),
        ),
    };
    // SkillLibrary reads provider snapshots and asks for rescans, nothing else.
    const registry = stub as ProviderRegistry.ProviderRegistry["Service"];
    const realProject = yield* fileSystem.realPath(project);
    const projects = ProjectService.ProjectService.of({
      getByWorkspaceRoot: (root: string) =>
        Effect.succeed(
          path.resolve(root) === project || path.resolve(root) === realProject
            ? Option.some({
                id: ProjectId.make("project"),
                title: "Project",
                workspaceRoot: project,
              })
            : Option.none(),
        ),
    } as unknown as ProjectService.ProjectService["Service"]);

    const entry = path.resolve(import.meta.dirname, "../bin.ts");
    const library = yield* SkillLibrary.SkillLibrary.pipe(
      Effect.provide(
        SkillLibrary.layer.pipe(
          Layer.provide(ProcessRunner.layer),
          Layer.provide(Layer.succeed(ProviderRegistry.ProviderRegistry, registry)),
          Layer.provide(Layer.succeed(ProjectService.ProjectService, projects)),
        ),
      ),
      Effect.provideService(HostProcess.Environment, {
        ...process.env,
        HOME: home,
        XDG_STATE_HOME: "",
      }),
      Effect.provideService(HostProcess.Arguments, [process.execPath, entry]),
      Effect.provideService(HostProcess.IsExecutable, false),
    );
    return yield* body({ library, home, project, source, providers, refreshed });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "previews a source without installing it",
  () =>
    withLibrary(({ library, home, source }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const preview = yield* library.preview({ source });
        assert.deepEqual(
          preview.skills.map((skill) => [
            skill.name,
            skill.folder,
            skill.description,
            skill.scripts,
          ]),
          [
            ["Git Review", "git-review", "Review with git.", false],
            ["notes", "notes", "Take notes.", false],
            ["review", "review", "Review a change.", true],
          ],
        );
        assert.deepEqual(
          preview.skills[2]?.files.map((file) => [file.path, file.executable, file.script]),
          [
            ["SKILL.md", false, false],
            ["bin/run", true, true],
          ],
        );
        assert.isFalse(yield* fileSystem.exists(`${home}/.agents`));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  120_000,
);

it.effect(
  "installs into a project, reports the source, and removes it again",
  () =>
    withLibrary(({ library, project, source, providers, refreshed }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* library.install({
          source,
          skills: ["review"],
          target: { kind: "project", cwd: project },
        });
        assert.deepEqual(result.outcomes, [{ name: "review", status: "installed" }]);
        // Claude reads only `.claude/skills`, so it gets a link there.
        const claudeLink = path.join(project, ".claude", "skills", "review", "SKILL.md");
        assert.isTrue(yield* fileSystem.exists(claudeLink));
        assert.isFalse(yield* fileSystem.exists(path.join(project, ".agents/skills/notes")));
        assert.deepEqual(
          (yield* Ref.get(refreshed)).filter((entry) => entry.startsWith("workspace:")),
          [`workspace:claude:${project}`],
        );

        yield* Ref.set(providers, [
          {
            ...claude,
            workspaceSnapshots: [
              {
                cwd: project,
                checkedAt: "2026-10-09T00:00:00Z",
                slashCommands: [],
                skills: [{ name: "review", path: claudeLink, scope: "project", enabled: true }],
              },
            ],
          },
        ]);
        const inspected = yield* library.inspect({ cwd: project });
        assert.equal(inspected.folders.length, 1);
        const folder = inspected.folders[0];
        assert.equal(folder?.path, claudeLink);
        assert.equal(
          folder?.folder,
          yield* fileSystem.realPath(path.join(project, ".agents/skills/review")),
        );
        assert.isTrue(folder?.scripts);
        // A project lock keeps a local source relative to the project, so it travels with it.
        assert.deepEqual(folder?.installed, {
          target: { kind: "project", cwd: project },
          source: path.relative(yield* fileSystem.realPath(project), source),
        });

        const updated = yield* library.update({
          name: "review",
          target: { kind: "project", cwd: project },
        });
        assert.deepEqual(updated.outcomes, [{ name: "review", status: "installed" }]);

        yield* library.remove({ name: "review", target: { kind: "project", cwd: project } });
        assert.isFalse(yield* fileSystem.exists(path.join(project, ".agents/skills/review")));
        assert.isFalse(yield* fileSystem.exists(path.join(project, ".claude/skills/review")));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  180_000,
);

it.effect(
  "refuses folders that aren't projects and skills the CLI didn't install",
  () =>
    withLibrary(({ library, home, source }) =>
      Effect.gen(function* () {
        const notProject = yield* library
          .install({ source, skills: ["review"], target: { kind: "project", cwd: home } })
          .pipe(Effect.flip);
        assert.equal(notProject.reason, "projectNotRegistered");
        const notInstalled = yield* library
          .remove({ name: "review", target: { kind: "environment" } })
          .pipe(Effect.flip);
        assert.equal(notInstalled.reason, "notInstalled");
      }),
    ),
  60_000,
);

it.effect(
  "removes a skill put in an agent folder by hand, and only from the agents' own folders",
  () =>
    withLibrary(({ library, home, providers }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // A hand-made skill in ~/.agents/skills, linked into ~/.claude/skills
        // the way other installers do, plus one only in a plugin's folder.
        const own = path.join(home, ".agents", "skills", "handmade");
        const link = path.join(home, ".claude", "skills", "handmade");
        const plugin = path.join(home, ".claude", "plugins", "acme", "skills", "handmade");
        yield* fileSystem.makeDirectory(own, { recursive: true });
        yield* fileSystem.writeFileString(path.join(own, "SKILL.md"), SKILL("handmade", "Mine."));
        yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
        yield* fileSystem.symlink(own, link);
        yield* fileSystem.makeDirectory(plugin, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(plugin, "SKILL.md"),
          SKILL("handmade", "A plugin's."),
        );
        const reported = (skillPath: string) => ({
          name: "handmade",
          path: skillPath,
          scope: "user",
          enabled: true,
        });
        yield* Ref.set(providers, [
          {
            ...claude,
            skills: [
              reported(path.join(link, "SKILL.md")),
              reported(path.join(plugin, "SKILL.md")),
            ],
          },
        ]);

        const inspected = yield* library.inspect({});
        assert.deepEqual(
          inspected.folders.map((folder) => [folder.path, folder.location?.kind, folder.installed]),
          [
            [path.join(link, "SKILL.md"), "environment", undefined],
            [path.join(plugin, "SKILL.md"), undefined, undefined],
          ],
        );

        yield* library.remove({ name: "handmade", target: { kind: "environment" } });
        assert.isFalse(yield* fileSystem.exists(own));
        assert.isFalse(
          yield* fileSystem.readLink(link).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
        );
        // The plugin's copy isn't the user's to remove.
        assert.isTrue(yield* fileSystem.exists(path.join(plugin, "SKILL.md")));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  60_000,
);

it.effect(
  "copies a skill to another environment as files, with links for agents that need them",
  () =>
    withLibrary(({ library, home, project, providers }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // On the first environment: a project skill with a script.
        const folder = path.join(project, ".agents", "skills", "lint");
        yield* fileSystem.makeDirectory(path.join(folder, "bin"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(folder, "SKILL.md"), SKILL("lint", "Lint."));
        yield* fileSystem.writeFileString(path.join(folder, "bin", "run"), "#!/bin/sh\n");
        yield* fileSystem.chmod(path.join(folder, "bin", "run"), 0o755);
        yield* Ref.set(providers, [
          {
            ...claude,
            workspaceSnapshots: [
              {
                cwd: project,
                checkedAt: "2026-10-10T00:00:00Z",
                slashCommands: [],
                skills: [
                  {
                    name: "lint",
                    path: path.join(folder, "SKILL.md"),
                    scope: "project",
                    enabled: true,
                  },
                ],
              },
            ],
          },
        ]);
        const bundle = yield* library.exportSkill({
          name: "lint",
          target: { kind: "project", cwd: project },
        });
        assert.deepEqual(
          bundle.files.map((file) => [file.path, file.executable]),
          [
            ["SKILL.md", false],
            ["bin/run", true],
          ],
        );

        // On the second environment (the same service here): a global copy.
        yield* library.importSkill({ bundle, target: { kind: "environment" } });
        const copied = path.join(home, ".agents", "skills", "lint");
        assert.equal(
          yield* fileSystem.readFileString(path.join(copied, "SKILL.md")),
          SKILL("lint", "Lint."),
        );
        assert.equal(
          ((yield* fileSystem.stat(path.join(copied, "bin", "run"))).mode & 0o111) !== 0,
          true,
        );
        // Claude reads only `.claude/skills`, so it gets a link, as an install gives it.
        assert.equal(
          yield* fileSystem.readLink(path.join(home, ".claude", "skills", "lint")),
          copied,
        );

        const again = yield* library
          .importSkill({ bundle, target: { kind: "environment" } })
          .pipe(Effect.flip);
        assert.equal(again.reason, "exists");

        const escape = yield* library
          .importSkill({
            bundle: {
              folder: "evil",
              files: [{ path: "../../outside", contents: "", executable: false }],
            },
            target: { kind: "environment" },
          })
          .pipe(Effect.flip);
        assert.equal(escape.reason, "cliFailed");
        assert.isFalse(yield* fileSystem.exists(path.join(home, ".agents", "outside")));
        assert.isFalse(yield* fileSystem.exists(path.join(home, ".agents", "skills", "evil")));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  60_000,
);

it.effect(
  "fails a removal the CLI couldn't finish, which it reports with a zero exit",
  () =>
    withLibrary(({ library, project, source }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = { kind: "project", cwd: project } as const;
        yield* library.install({ source, skills: ["notes"], target });
        const folder = path.join(project, ".agents", "skills");
        yield* fileSystem.chmod(folder, 0o555);
        const failure = yield* library
          .remove({ name: "notes", target })
          .pipe(Effect.flip, Effect.ensuring(fileSystem.chmod(folder, 0o755).pipe(Effect.ignore)));
        assert.equal(failure.reason, "cliFailed");
        assert.isTrue(yield* fileSystem.exists(path.join(folder, "notes")));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  120_000,
);

it.effect(
  "keeps both lock entries when two installs run at once, and rescans listed projects",
  () =>
    withLibrary(({ library, home, project, source, providers, refreshed }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = { kind: "environment" } as const;
        // Two agents have listed this project's skills, which include the global ones.
        const listed = {
          workspaceSnapshots: [
            { cwd: project, checkedAt: "2026-10-09T00:00:00Z", slashCommands: [], skills: [] },
          ],
        };
        yield* Ref.set(providers, [
          { ...claude, ...listed },
          {
            ...claude,
            ...listed,
            driver: ProviderDriverKind.make("codex"),
            instanceId: ProviderInstanceId.make("codex"),
          },
        ]);
        yield* Effect.all(
          [
            library.install({ source, skills: ["notes"], target }),
            library.install({ source, skills: ["review"], target }),
          ],
          { concurrency: "unbounded" },
        );
        const lock = JSON.parse(
          yield* fileSystem.readFileString(path.join(home, ".agents", ".skill-lock.json")),
        ) as { skills: Record<string, unknown> };
        expect(Object.keys(lock.skills).toSorted()).toEqual(["notes", "review"]);
        const refreshes = yield* Ref.get(refreshed);
        expect(refreshes).toContain(`workspace:claude:${project}`);
        expect(refreshes).toContain(`workspace:codex:${project}`);
        // A fresh scan drops other agents' snapshots of the folder, so they take turns,
        // and only the first is fresh: a later one would drop the first one's result.
        expect(refreshes.filter((entry) => entry.startsWith("overlap:"))).toEqual([]);
        // Each of the two installs rescans the project once, Claude fresh and Codex after it.
        expect(refreshes.filter((entry) => entry.startsWith("fresh:"))).toEqual([
          `fresh:claude:${project}:true`,
          `fresh:codex:${project}:false`,
          `fresh:claude:${project}:true`,
          `fresh:codex:${project}:false`,
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  120_000,
);

it.effect(
  "installs, updates and removes a skill whose name isn't its folder",
  () =>
    withLibrary(({ library, project, source }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target = { kind: "project", cwd: project } as const;
        const preview = yield* library.preview({ source });
        const gitReview = preview.skills.find((skill) => skill.folder === "git-review");
        assert.equal(gitReview?.name, "Git Review");
        const installed = yield* library.install({ source, skills: ["Git Review"], target });
        assert.deepEqual(installed.outcomes, [{ name: "Git Review", status: "installed" }]);
        const folder = path.join(project, ".agents", "skills", "git-review");
        assert.isTrue(yield* fileSystem.exists(folder));
        // The list knows the skill by its folder; update and remove find the lock's name.
        const updated = yield* library.update({ name: "git-review", target });
        assert.deepEqual(updated.outcomes, [{ name: "Git Review", status: "installed" }]);
        yield* library.remove({ name: "git-review", target });
        assert.isFalse(yield* fileSystem.exists(folder));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  180_000,
);

it.effect(
  "previews a source whose result is larger than one pipe buffer",
  () =>
    withLibrary(({ library, home }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // About 360 bytes of JSON per skill, so 250 skills is well past 64 KiB.
        const big = path.join(home, "big");
        yield* Effect.forEach(
          Array.from({ length: 250 }, (_, index) => `skill-${String(index).padStart(3, "0")}`),
          (name) =>
            fileSystem
              .makeDirectory(path.join(big, name), { recursive: true })
              .pipe(
                Effect.andThen(
                  fileSystem.writeFileString(
                    path.join(big, name, "SKILL.md"),
                    SKILL(name, `Skill ${name}.`),
                  ),
                ),
              ),
          { discard: true },
        );
        const preview = yield* library.preview({ source: big });
        assert.equal(preview.skills.length, 250);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  180_000,
);

describe("lockedInstallSource", () => {
  it("updates one skill from its folder, as `npx skills update` does", () => {
    const skillPath = "skills/productivity/grill-me/SKILL.md";
    expect(
      lockedInstallSource({ source: "mattpocock/skills", sourceType: "github", skillPath }, "home"),
    ).toEqual({ source: "mattpocock/skills/skills/productivity/grill-me", fullDepth: false });
    // A source that can't take a folder is searched in full, so a root SKILL.md can't win.
    expect(
      lockedInstallSource(
        { source: "git@example.com:team/skills.git", sourceType: "git", skillPath, ref: "v2" },
        "project",
      ),
    ).toEqual({ source: "git@example.com:team/skills.git#v2", fullDepth: true });
  });

  it("uses a recorded GitLab URL, and refuses a GitLab shorthand GitHub would answer", () => {
    const skillPath = "tools/review/SKILL.md";
    expect(
      lockedInstallSource(
        {
          source: "group/repo",
          sourceType: "gitlab",
          sourceUrl: "https://gitlab.com/group/repo",
          skillPath,
        },
        "project",
      ),
    ).toEqual({ source: "https://gitlab.com/group/repo/tools/review", fullDepth: false });
    expect(
      lockedInstallSource({ source: "group/repo", sourceType: "gitlab", skillPath }, "project"),
    ).toBeNull();
  });
});
